#!/usr/bin/env node
/**
 * taco CLI — Node shim that locates the ESM dispatcher and spawns it.
 *
 * This file is CJS so npm `bin` entries can bootstrap the ESM runtime
 * without a `--loader` flag. Resolution order:
 *   1. TACO_CLI_ENTRY env var — an explicit path to a compiled bundle.
 *   2. ../lib/index.ts via a locally resolvable tsx loader — the repo-dev
 *      path. Preferred over dist/ so launcher edits apply without a rebuild,
 *      and so we never spawn tsx/dist/cli.mjs (it re-forks node).
 *   3. ../dist/taco.mjs — the esbuild bundle produced by `pnpm build`,
 *      which is what ships in the published package and runs under plain
 *      Node (no tsx).
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const DIST_ENTRY = path.join(__dirname, "..", "dist", "taco.mjs");
const SRC_ENTRY = path.join(__dirname, "..", "lib", "index.ts");

function locateTsxLoader() {
    // Walk up from this file looking for `tsx/dist/loader.mjs`. Handles pnpm's
    // nested node_modules as well as global installs. Used on the repo-dev
    // path, where tsx is a devDependency.
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, "node_modules", "tsx", "dist", "loader.mjs");
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function resolveEntry() {
    if (process.env.TACO_CLI_ENTRY) return [process.env.TACO_CLI_ENTRY];
    // Prefer TypeScript source in a checkout so `pnpm tauri:dev` picks up
    // launcher edits without a CLI rebuild. `tsx/dist/cli.mjs` re-forks
    // node (and flashes a console on Windows); `--import` the loader
    // instead so this process is the one that runs lib/index.ts.
    const tsx = locateTsxLoader();
    if (tsx && existsSync(SRC_ENTRY)) {
        const { pathToFileURL } = require("node:url");
        return ["--import", pathToFileURL(tsx).href, SRC_ENTRY];
    }
    if (existsSync(DIST_ENTRY)) return [DIST_ENTRY];
    throw new Error(
        "Could not find the taco CLI entry point.\n" +
            `  Expected the built bundle at ${DIST_ENTRY}.\n` +
            "  In a source checkout, run `pnpm install` so tsx can run the TypeScript source " +
            "(or `pnpm --filter @taco-ai/cli build` for the published bundle).",
    );
}

const child = spawn(process.execPath, [...resolveEntry(), ...process.argv.slice(2)], {
    stdio: "inherit",
    // Windows: this shim is itself a console node.exe. Hide the inner
    // process so a GUI parent (debug TACO.exe with CREATE_NO_WINDOW) does
    // not flash a second console. Ignored on POSIX.
    windowsHide: true,
});

child.on("exit", (code, sig) => {
    process.exitCode = code ?? (sig === "SIGKILL" ? 137 : 1);
});
