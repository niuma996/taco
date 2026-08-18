#!/usr/bin/env node
/**
 * syncPnpmStaging.mjs — copy the freshly-built dist/runtime/<triple>/ into
 * the installed @taco-ai/sidecar-<platform>/ package under node_modules.
 *
 * Why this exists: `taco install` writes a launchd wrapper that points at
 * `node_modules/.pnpm/@taco-ai+sidecar-<platform>@<ver>/...` — that path is
 * resolved ONCE at install time and never re-resolved. Running
 * `package:runtime` writes to packages/sidecar/dist/runtime/, which the
 * daemon does NOT see. Without this sync, a developer who rebuilds the
 * sidecar ships the new code only to the desktop's Tauri bundle; the
 * launchd-spawned daemon keeps running the old bundle and the client
 * shows "sidecar connected but sent no hello within 5s".
 *
 * This script is idempotent and safe to re-run. It only touches the
 * current-host platform's package — other platform packages (installed
 * for cross-building) are left alone.
 *
 * Pass `--rebuild` to force `package:runtime` before syncing. Earlier
 * revisions tried to skip the rebuild via a src-vs-bundle mtime
 * comparison, but the comparison missed real src changes (esbuild
 * doesn't always touch the bundle file's mtime when only a transitive
 * dep changed, and copy-then-rebuild races can leave staged mtimes
 * ahead of src). `tauri:dev`'s `stageSidecar.mjs` calls this with
 * `--rebuild` so the dev inner loop always runs against the latest
 * sidecar; the rebuild cost is bounded because it's a one-shot, not
 * a per-HMR step.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentTriple } from "./triple.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(SCRIPT_DIR, "..");
const DIST = join(PKG_DIR, "dist", "runtime");

/** Map host triple → optional dep name. Keep in sync with the platform
 *  table in stagePlatformPackages.mjs and PLATFORM_KEYS in
 *  packages/cli/lib/upgradePlatform.ts. */
const TRIPLE_TO_PKG = {
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
    "x86_64-pc-windows-msvc": "win32-x64",
    "aarch64-pc-windows-msvc": "win32-arm64",
};

/** Top-level entries that get refreshed in the staging package. We leave
 *  `bin/taco-sidecar-node` alone — the binary rarely changes across
 *  sidecar-only rebuilds and copying 112MB on every `tauri:dev` is
 *  wasteful. Manifest is included because `installHelpers.findPlatformPkg`
 *  reads it to discover the daemon-mode capability. */
const SYNC_ENTRIES = ["lib", "agents", "skills", "manifest.json"];

function main() {
    const args = process.argv.slice(2);
    const rebuild = args.includes("--rebuild");
    const triple = currentTriple();
    const pkgSuffix = TRIPLE_TO_PKG[triple];
    if (!pkgSuffix) {
        console.error(`[syncPnpmStaging] unsupported triple: ${triple}`);
        process.exit(1);
    }

    const src = join(DIST, triple);
    if (rebuild) {
        // Always rebuild on --rebuild. The previous mtime-based skip
        // missed real src changes (esbuild's output mtime doesn't reflect
        // every transitive dep touch, and copy-then-rebuild cycles can
        // leave staged mtimes ahead of src). Forcing the rebuild keeps
        // the staged bundle in lockstep with src — the cost is bounded
        // because callers use --rebuild from `beforeDevCommand`, not
        // from a per-HMR hook.
        console.log("[syncPnpmStaging] --rebuild: forcing package:runtime");
        const r = spawnSync("pnpm", ["--filter", "@taco-ai/sidecar", "package:runtime"], {
            cwd: resolve(PKG_DIR, "..", ".."),
            stdio: "inherit",
        });
        if (r.status !== 0) {
            process.exit(r.status ?? 1);
        }
    }

    if (!existsSync(src)) {
        console.error(
            `[syncPnpmStaging] dist/runtime/${triple} not built yet — run ` +
                "`pnpm --filter @taco-ai/sidecar package:runtime` first",
        );
        process.exit(1);
    }

    // Resolve the installed package the same way installHelpers.findPlatformPkg
    // does, so dev-mode (sync) and install-mode (read) agree on the path.
    const require = createRequire(join(PKG_DIR, "package.json"));
    let pkgDir;
    try {
        const pkgJsonPath = require.resolve(`@taco-ai/sidecar-${pkgSuffix}/package.json`);
        pkgDir = dirname(pkgJsonPath);
    } catch (err) {
        console.error(
            `[syncPnpmStaging] @taco-ai/sidecar-${pkgSuffix} not installed; ` +
                `run \`pnpm install\` and retry (${String(err)})`,
        );
        process.exit(1);
    }

    for (const name of SYNC_ENTRIES) {
        const from = join(src, name);
        if (!existsSync(from)) {
            console.warn(`[syncPnpmStaging] skip missing ${name} in ${src}`);
            continue;
        }
        const to = join(pkgDir, name);
        if (existsSync(to)) rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
    }

    // Sanity-check the synced bundle still has daemon mode. The manifest's
    // `daemonMode` field is the primary signal, but a manifest produced by
    // an older buildRuntime (pre-field) is indistinguishable from a stale
    // bundle on this check alone — fall back to grepping the bundle the
    // same way installHelpers.findPlatformPkg does. This keeps the check
    // useful (it catches a real regression where src/index.ts no longer
    // imports the daemon entry) without forcing every rebuild-from-old-
    // state to be a fatal error.
    const manifestPath = join(pkgDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.daemonMode !== true) {
        const bundleText = readFileSync(join(pkgDir, "lib", "index.mjs"), "utf8");
        if (!bundleText.includes("TACO_DAEMON_MODE")) {
            console.error(
                "[syncPnpmStaging] synced bundle lacks daemon-mode marker; " +
                    "check that packages/sidecar/src/index.ts still imports the daemon entry",
            );
            process.exit(1);
        }
    }

    console.log(`[syncPnpmStaging] synced ${triple} → ${pkgDir}`);
}

main();
