#!/usr/bin/env node
/**
 * stageSidecar.mjs — copy sidecar runtime artifacts to the Tauri layout.
 *
 * Stages dist/runtime/<triple>/{lib,agents,skills} → src-tauri/generated/sidecar/
 * and copies the node binary to src-tauri/binaries/taco-sidecar-node-<triple>.
 * Runs before `tauri:dev` to prepare the host platform's release artifacts.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { currentTriple, parseTargetCli } from "../../../packages/sidecar/scripts/triple.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const srcTauri = join(desktopDir, "src-tauri");
const binariesDir = join(srcTauri, "binaries");
const generatedDir = join(srcTauri, "generated", "sidecar");
// Repo layout: clients/ and packages/ are siblings, not clients/packages/
const repoRoot = join(desktopDir, "..", "..");
const sidecarPkgDir = join(repoRoot, "packages", "sidecar");
const cliPkgDir = join(repoRoot, "packages", "cli");
const runtimeDir = join(sidecarPkgDir, "dist", "runtime");

function main() {
    const explicitTarget = parseTargetCli(process.argv.slice(2));
    const triple = explicitTarget ?? currentTriple();

    const runtimeTriple = join(runtimeDir, triple);
    if (!existsSync(runtimeTriple)) {
        console.warn(`[stageSidecar] runtime ${triple} not built; running package:runtime —`);
        // Pass --target through so an explicit triple is built, not the host
        // triple. package:runtime without --target falls back to current host.
        const pnpmArgs = ["--filter", "@taco-ai/sidecar", "package:runtime", "--strict"];
        if (explicitTarget) pnpmArgs.push("--target", explicitTarget);
        const r = spawnSync("pnpm", pnpmArgs, {
            cwd: join(desktopDir, "..", ".."),
            stdio: "inherit",
        });
        if (r.status !== 0) {
            // stdio:"inherit" on Windows runners inside Tauri's
            // beforeBuildCommand swallows the child's stderr. Re-run
            // capturing both streams so the failure is actually visible
            // in CI logs instead of just "[stageSidecar] package:runtime
            // failed".
            const captured = spawnSync("pnpm", pnpmArgs, {
                cwd: join(desktopDir, "..", ".."),
                stdio: ["ignore", "pipe", "pipe"],
                encoding: "utf8",
            });
            const tail = (s) => (s ?? "").split("\n").slice(-20).join("\n");
            console.error(
                `[stageSidecar] package:runtime failed (status ${captured.status})\n` +
                    `--- stdout (tail) ---\n${tail(captured.stdout)}\n` +
                    `--- stderr (tail) ---\n${tail(captured.stderr)}`,
            );
            process.exit(captured.status ?? 1);
        }
        if (!existsSync(runtimeTriple)) {
            console.error(
                `[stageSidecar] runtime ${triple} still not present after build; aborting`,
            );
            process.exit(1);
        }
    }

    // Sync the runtime into the installed @taco-ai/sidecar-<platform>/
    // package so a launchd-managed daemon picks up the new bundle. Without
    // this the daemon keeps running whatever was current at `taco install`
    // time and `beforeDevCommand` looks like it has no effect on the
    // running sidecar — exactly the regression that produced the 5s hello
    // timeout. Cross-target builds (rare; --target windows on a mac host)
    // skip this step because the daemon is a host-platform concept only.
    //
    // `--rebuild` makes sync re-run package:runtime whenever the sidecar
    // src is newer than the staged bundle, so developers editing sidecar
    // code don't have to remember to rebuild before `tauri dev`.
    // CI skips the sync: the launchd daemon is a dev-machine concept, and
    // the source manifest no longer lists per-platform optionalDeps (Plan B),
    // so sync:staging's require.resolve would fail on the runner. The release
    // bundle stages the runtime into generated/ below and never reads the
    // launchd path.
    if (!process.env.CI && (!explicitTarget || explicitTarget === currentTriple())) {
        const sync = spawnSync(
            "pnpm",
            ["--filter", "@taco-ai/sidecar", "sync:staging", "--", "--rebuild"],
            {
                cwd: repoRoot,
                stdio: "inherit",
            },
        );
        if (sync.status !== 0) {
            // Sync failure is a hard error: continuing here would let
            // `tauri dev` come up against a stale daemon and the developer
            // would only find out via a 5s hello timeout in the client.
            process.exit(sync.status ?? 1);
        }
    }

    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });

    // Copy lib / agents / skills → generated/sidecar/{lib,agents,skills}
    const targets = ["lib", "agents", "skills", "manifest.json"];
    for (const name of targets) {
        const src = join(runtimeTriple, name);
        if (!existsSync(src)) {
            console.warn(`[stageSidecar] missing source: ${src}; skip`);
            continue;
        }
        const dst = join(generatedDir, name);
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        cpSync(src, dst, { recursive: true });
    }

    // CLI bundle → generated/cli/taco.mjs. Release-mode desktop startup uses
    // the already-bundled sidecar Node executable to run this entry, so it
    // never depends on a globally-installed `taco` command or `tsx`.
    const cliDist = join(cliPkgDir, "dist", "taco.mjs");
    if (!existsSync(cliDist)) {
        const r = spawnSync("pnpm", ["--filter", "@taco-ai/cli", "build"], {
            cwd: repoRoot,
            stdio: "inherit",
        });
        if (r.status !== 0 || !existsSync(cliDist)) {
            console.error(`[stageSidecar] CLI bundle missing after build: ${cliDist}`);
            process.exit(r.status ?? 1);
        }
    }
    const cliGeneratedDir = join(srcTauri, "generated", "cli");
    mkdirSync(cliGeneratedDir, { recursive: true });
    cpSync(cliDist, join(cliGeneratedDir, "taco.mjs"));

    // Node binary → binaries/taco-sidecar-node-<triple>
    // Tauri 2's externalBin expects naming "<basename>-<triple>"; we only consume
    // this file, so the basename is "taco-sidecar-node". On Windows msvc triples
    // buildRuntime writes `taco-sidecar-node.exe`; on every other triple the
    // binary is unprefixed. Match the same triple-suffix check buildRuntime
    // uses so a missing .exe on windows doesn't fall through to a silent
    // "node binary missing" failure.
    const nodeBinName = triple.endsWith("-msvc") ? "taco-sidecar-node.exe" : "taco-sidecar-node";
    const nodeSrc = join(runtimeTriple, "bin", nodeBinName);
    if (!existsSync(nodeSrc)) {
        console.error(`[stageSidecar] node binary missing: ${nodeSrc}`);
        process.exit(1);
    }
    // Node binary → binaries/taco-sidecar-node-<triple>[.exe]
    // Tauri 2's externalBin expects naming "<basename>-<triple>" with the
    // platform-specific suffix appended (".exe" on Windows msvc triples).
    // buildRuntime writes `taco-sidecar-node.exe` on -msvc triples and
    // `taco-sidecar-node` on every other triple. The destination filename
    // must carry the same suffix — Tauri literally fails its build script
    // with `resource path <basename>-<triple>.exe doesn't exist` when it
    // is missing, which surfaces as a rustc "failed to run custom build
    // command" with no actionable diagnostic.
    const nodeBinExt = triple.endsWith("-msvc") ? ".exe" : "";
    const tauriBin = join(binariesDir, `taco-sidecar-node-${triple}${nodeBinExt}`);
    cpSync(nodeSrc, tauriBin);
    if (process.platform !== "win32") {
        try {
            chmodSync(tauriBin, 0o755);
        } catch {
            /* ignore */
        }
    }
    console.log(`[stageSidecar] staged ${triple} →`);
    console.log(`  resources: ${generatedDir}`);
    console.log(`  externalBin: ${tauriBin}`);
}

main();
