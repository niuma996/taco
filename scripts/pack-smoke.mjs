#!/usr/bin/env node
/**
 * pack-smoke.mjs — consumer install + entry-point smoke test.
 * Builds the three published packages, packs each into a tarball, installs them
 * into a fresh consumer dir, and asserts the public surface still resolves.
 * Catches breakage that escapes workspace-relative tests: bad `files`
 * whitelist, missing build artifact, stale `workspace:*`, broken `exports`.
 * Run from repo root. Exits 0 on success, 1 on first failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Run a command, streaming output. Throws on non-zero exit. */
function run(cmd, args, opts = {}) {
    const label = `[${opts.label ?? cmd}] ${[cmd, ...args].join(" ")}`;
    console.log(label);
    const result = spawnSync(cmd, args, {
        cwd: opts.cwd ?? REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, ...(opts.env ?? {}) },
    });
    if (opts.capture && result.stdout) process.stdout.write(result.stdout);
    if (!opts.silent && result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
        throw new Error(`${label} exited ${result.status}`);
    }
    return result;
}

/** Capture combined stdout+stderr. Throws on non-zero. */
function capture(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, {
        cwd: opts.cwd ?? REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, ...(opts.env ?? {}) },
    });
    return {
        status: result.status ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** Pull the tarball path pnpm pack prints in its last block. */
function parsePackOutput(stdout) {
    // pnpm pack prints a "Tarball Details" block ending with the absolute path.
    const matches = [...stdout.matchAll(/Tarball Details\n([^\n]+)/g)];
    const last = matches[matches.length - 1];
    if (!last) throw new Error("could not parse pnpm pack output:\n" + stdout);
    return last[1].trim();
}

const pkgDefs = [
    { filter: "@taco-ai/protocol", label: "protocol" },
    { filter: "@taco-ai/shared", label: "shared" },
    { filter: "@taco-ai/sidecar", label: "sidecar" },
];

async function main() {
    const tmp = mkdtempSync(join(tmpdir(), "taco-pack-smoke-"));
    const pkgsDir = join(tmp, "pkgs");
    const consumerDir = join(tmp, "consumer");
    mkdirSync(pkgsDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });

    console.log(`[STEP] tmp dir: ${tmp}`);
    try {
        // 1. Build — use the existing scripts so we exercise the same path
        //    that release-sidecar.yml's `publish` job exercises.
        console.log("[STEP] build protocol");
        run("pnpm", ["protocol:build"], { label: "pnpm protocol:build" });
        console.log("[STEP] build shared");
        run("pnpm", ["shared:build"], { label: "pnpm shared:build" });
        console.log("[STEP] build sidecar bundle");
        run("pnpm", ["--filter", "@taco-ai/sidecar", "build"], {
            label: "pnpm --filter @taco-ai/sidecar build",
        });

        // 2. Pack each into <tmp>/pkgs/. pnpm pack rewrites `workspace:*` to
        //    the actual version — verified empirically — so the shared tarball
        //    resolves @taco-ai/protocol when npm installs it below.
        const tarballs = {};
        for (const { filter, label } of pkgDefs) {
            console.log(`[STEP] pack ${label}`);
            const result = capture(
                "pnpm",
                ["--filter", filter, "pack", "--pack-destination", pkgsDir],
                {
                    cwd: REPO_ROOT,
                },
            );
            if (result.status !== 0) {
                process.stderr.write(result.stderr);
                throw new Error(`pnpm pack ${filter} failed`);
            }
            const tgz = parsePackOutput(result.stdout);
            if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce ${tgz}`);
            tarballs[label] = tgz;
            console.log(`  -> ${tgz}`);
        }

        // 3. Init consumer. npm (not pnpm) — exercises the real consumer
        //    install path. Install in dependency order so shared's transitive
        //    `@taco-ai/protocol` resolves to the local protocol tarball.
        console.log("[STEP] init consumer");
        run("npm", ["init", "-y"], { cwd: consumerDir, label: "npm init" });

        console.log("[STEP] npm install protocol tarball");
        run("npm", ["install", "--no-fund", "--no-audit", tarballs.protocol], {
            cwd: consumerDir,
            label: "npm install protocol",
        });
        console.log("[STEP] npm install shared tarball");
        run("npm", ["install", "--no-fund", "--no-audit", tarballs.shared], {
            cwd: consumerDir,
            label: "npm install shared",
        });
        console.log("[STEP] npm install sidecar tarball (skip script on install)");
        run("npm", ["install", "--no-fund", "--no-audit", "--ignore-scripts", tarballs.sidecar], {
            cwd: consumerDir,
            label: "npm install sidecar",
        });

        // 4. Assertions — each step fails loudly with a single-line reason
        //    so CI logs stay diagnosable.
        await assertProtocolLoads(consumerDir);
        await assertSharedNodeExports(consumerDir);
        await assertSharedSpawnExports(consumerDir);
        assertSidecarShimInstalled(consumerDir);
        await assertSidecarBinShimErrorsCleanlyOnNoPlatform(consumerDir);
        await assertTypescriptConsumerCompiles(consumerDir);

        console.log("\n[OK] pack-smoke");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

async function assertProtocolLoads(consumerDir) {
    console.log("[CHECK] protocol: import @taco-ai/protocol");
    const result = await captureNodeEval(
        `import('@taco-ai/protocol').then(m => {` +
            ` if (typeof m.SIDECAR_PROTOCOL_VERSION !== 'object') throw new Error('SIDECAR_PROTOCOL_VERSION missing');` +
            ` if (typeof m.isCompatibleSidecarProtocol !== 'function') throw new Error('isCompatibleSidecarProtocol missing');` +
            ` if (!m.isCompatibleSidecarProtocol({major:1, minor:5})) throw new Error('compat false on minor bump');` +
            "}).catch(e => { console.error(e.message); process.exit(1); })",
        consumerDir,
    );
    if (result.status !== 0)
        throw new Error(`protocol import failed: ${result.stderr || result.stdout}`);
}

async function assertSharedNodeExports(consumerDir) {
    console.log("[CHECK] shared/node: TacoClient class");
    const result = await captureNodeEval(
        `import('@taco-ai/shared/node').then(m => {` +
            ` if (typeof m.TacoClient !== 'function') throw new Error('TacoClient export missing or not a class');` +
            "}).catch(e => { console.error(e.message); process.exit(1); })",
        consumerDir,
    );
    if (result.status !== 0)
        throw new Error(`shared/node import failed: ${result.stderr || result.stdout}`);
}

async function assertSharedSpawnExports(consumerDir) {
    console.log("[CHECK] shared/spawn: createDefaultSidecarSpawn");
    const result = await captureNodeEval(
        `import('@taco-ai/shared/spawn').then(m => {` +
            ` if (typeof m.createDefaultSidecarSpawn !== 'function') throw new Error('createDefaultSidecarSpawn missing');` +
            "}).catch(e => { console.error(e.message); process.exit(1); })",
        consumerDir,
    );
    if (result.status !== 0)
        throw new Error(`shared/spawn import failed: ${result.stderr || result.stdout}`);
}

function assertSidecarShimInstalled(consumerDir) {
    console.log("[CHECK] sidecar: shim + bin + files");
    const pkgPath = join(consumerDir, "node_modules", "@taco-ai", "sidecar", "package.json");
    if (!existsSync(pkgPath)) throw new Error(`${pkgPath} not installed`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binPath = pkg.bin?.["taco-sidecar"];
    if (!binPath?.endsWith("taco-sidecar.cjs")) {
        throw new Error(`sidecar bin missing or wrong path: ${JSON.stringify(pkg.bin)}`);
    }
    if (!Array.isArray(pkg.files) || !pkg.files.includes("bin") || !pkg.files.includes("lib")) {
        throw new Error(`sidecar files whitelist unexpected: ${JSON.stringify(pkg.files)}`);
    }
    const shimFullPath = join(consumerDir, "node_modules", "@taco-ai", "sidecar", binPath);
    if (!existsSync(shimFullPath)) throw new Error(`shim missing on disk: ${shimFullPath}`);
    const bundlePath = join(
        consumerDir,
        "node_modules",
        "@taco-ai",
        "sidecar",
        "lib",
        "sidecar.mjs",
    );
    if (!existsSync(bundlePath)) throw new Error(`esbuild bundle missing: ${bundlePath}`);
}

async function assertSidecarBinShimErrorsCleanlyOnNoPlatform(consumerDir) {
    console.log("[CHECK] sidecar: bin shim behaves on missing platform");
    // The shim's missing-platform branch only fires when no matching
    // @taco-ai/sidecar-<platform> optional dep is installed. The release
    // matrix publishes darwin-* and win32-* tarballs but NOT linux-*,
    // so the CI ubuntu runner always hits this branch. macOS / Windows
    // devs running pack-smoke locally have their native platform tarball
    // installed by pnpm, so the shim runs the real binary and this
    // assertion would always fail there. Skip on non-linux platforms.
    if (process.platform !== "linux") {
        console.log(
            `  [SKIP] non-linux platform (${process.platform}) - native sidecar-* tarball installed`,
        );
        return;
    }
    const shim = join(consumerDir, "node_modules", ".bin", "taco-sidecar");
    const result = capture("node", [shim, "--help"], { cwd: consumerDir });
    // Expected: exit 1 + stderr matches "no platform-specific binary found".
    // This is the documented behavior when the matching @taco-ai/sidecar-<platform>
    // optional dep isn't installed (the normal case on Linux CI since we don't
    // build the sidecar-linux-* tarball here). A failure of the shim itself
    // (different stderr, different exit code) is a real regression.
    const matches = result.stderr.includes("no platform-specific binary found");
    if (result.status === 1 && matches) {
        console.log("  [SKIP] no platform tarball installed — shim correctly errors");
        return;
    }
    throw new Error(
        `sidecar bin shim unexpected behavior: status=${result.status} matches=${matches}\n` +
            `--- stderr ---\n${result.stderr}`,
    );
}

async function assertTypescriptConsumerCompiles(consumerDir) {
    console.log("[CHECK] TS consumer compiles against installed tarballs");
    const consumerTs = join(consumerDir, "consumer.ts");
    writeFileSync(
        consumerTs,
        [
            `import { SIDECAR_PROTOCOL_VERSION, type AgentMessage, type ThinkingLevel } from "@taco-ai/protocol";`,
            `import type { TacoClient } from "@taco-ai/shared/node";`,
            `import type { SidecarSpawn } from "@taco-ai/shared/spawn";`,
            `const _msg: AgentMessage = { role: "user", content: "x", timestamp: 0 };`,
            `const _lvl: ThinkingLevel = "high";`,
            "const _v: typeof SIDECAR_PROTOCOL_VERSION = SIDECAR_PROTOCOL_VERSION;",
            "const _c: TacoClient | null = null;",
            "const _s: SidecarSpawn | null = null;",
            "export {};",
        ].join("\n"),
    );

    // Use the repo's installed tsc — resolve via REPO_ROOT instead of relying
    // on npm hoisting in the consumer dir.
    const tscBin = join(REPO_ROOT, "node_modules", ".bin", "tsc");
    if (!existsSync(tscBin)) throw new Error(`tsc not found at ${tscBin}`);
    const result = capture(
        tscBin,
        [
            consumerTs,
            "--noEmit",
            "--moduleResolution",
            "nodenext",
            "--module",
            "nodenext",
            "--target",
            "es2022",
            "--skipLibCheck",
            "--strict",
        ],
        { cwd: consumerDir },
    );
    if (result.status !== 0) {
        throw new Error(
            `consumer.ts failed to compile:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
    }
}

function captureNodeEval(code, cwd) {
    return new Promise((resolve) => {
        // Spawn node directly via `process.execPath` so the shell never
        // touches the JS payload — the previous `shell: true` form made
        // /bin/sh interpret parentheses in the code as subshell syntax and
        // the eval failed with "Syntax error: '(' unexpected" on Linux /
        // macOS. On Windows, spawning the node executable by absolute path
        // also sidesteps shell-vs-PATH resolution that motivated the prior
        // form.
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (status) => resolve({ status, stdout, stderr }));
        child.on("error", (err) => resolve({ status: 1, stdout, stderr: String(err) }));
    });
}

main().catch((err) => {
    console.error(`\n[FAIL] pack-smoke: ${err.message}`);
    process.exit(1);
});
