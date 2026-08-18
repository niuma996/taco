#!/usr/bin/env node
/**
 * taco CLI — Node shim that locates the ESM dispatcher and spawns it.
 *
 * This file is CJS so npm `bin` entries can bootstrap the ESM runtime
 * without a `--loader` flag. Resolution order:
 *   1. TACO_CLI_ENTRY env var — an explicit path to a compiled bundle.
 *   2. ../dist/taco.mjs — the esbuild bundle produced by `pnpm build`,
 *      which is what ships in the published package and runs under plain
 *      Node (no tsx).
 *   3. ../lib/index.ts via a locally resolvable tsx — the repo-dev path,
 *      where dist/ may not have been built yet.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const DIST_ENTRY = path.join(__dirname, "..", "dist", "taco.mjs");
const SRC_ENTRY = path.join(__dirname, "..", "lib", "index.ts");

function locateTsxCli() {
    // Walk up from this file looking for `tsx/dist/cli.mjs`. Handles pnpm's
    // nested node_modules as well as global installs. Only used on the
    // repo-dev path, where tsx is a devDependency.
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function resolveEntry() {
    if (process.env.TACO_CLI_ENTRY) return [process.env.TACO_CLI_ENTRY];
    if (existsSync(DIST_ENTRY)) return [DIST_ENTRY];
    const tsx = locateTsxCli();
    if (tsx) return [tsx, SRC_ENTRY];
    throw new Error(
        "Could not find the taco CLI entry point.\n" +
            `  Expected the built bundle at ${DIST_ENTRY}.\n` +
            "  In a source checkout, run `pnpm --filter @taco-ai/cli build` " +
            "(or install dev deps so tsx can run the TypeScript source).",
    );
}

const child = spawn(process.execPath, [...resolveEntry(), ...process.argv.slice(2)], {
    stdio: "inherit",
});

child.on("exit", (code, sig) => {
    process.exitCode = code ?? (sig === "SIGKILL" ? 137 : 1);
});
