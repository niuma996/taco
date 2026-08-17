#!/usr/bin/env node
/**
 * taco CLI — Node shim that locates tsx + the ESM dispatch and spawns it.
 *
 * Same shape as `packages/sidecar/bin/taco-sidecar.cjs`: this file is CJS so
 * npm `bin` entries can bootstrap the ESM runtime without a `--loader` flag,
 * and it delegates to a TypeScript entry via tsx. Production packaging (PR3+)
 * will replace this with a pre-bundled ESM binary.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

function locateTsxCli() {
    // Walk up from this file looking for `tsx/dist/cli.mjs`. Same resolution
    // strategy as the sidecar shim — handles pnpm's nested node_modules as
    // well as global installs.
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        "tsx not found. Run `pnpm install` to install dev deps, or set " +
            "TACO_CLI_ENTRY to the compiled ESM dispatcher path.",
    );
}

const tsxCli = process.env.TACO_CLI_ENTRY ? process.env.TACO_CLI_ENTRY : locateTsxCli();
const libEntry = path.join(__dirname, "..", "lib", "index.ts");

const child = spawn(process.execPath, [tsxCli, libEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
});

child.on("exit", (code, sig) => {
    process.exitCode = code ?? (sig === "SIGKILL" ? 137 : 1);
});
