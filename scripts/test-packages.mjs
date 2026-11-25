#!/usr/bin/env node
/**
 * Runs the node:test package suite with a concurrency cap.
 *
 * node's default is `os.availableParallelism()` — one worker per core. That
 * is over-subscribed for this suite: most of its cost is real subprocess
 * spawns (git, daemons, the CLI's own binaries), and each worker forks
 * children of its own. Measured on a 10-core box:
 *
 *   concurrency 10 (default) → 96–146 s wall, 1/3 runs failed the chokidar
 *                              skill-watcher case (a 30–60 s stall)
 *   concurrency  6           → 106–138 s wall, 0/3 failures
 *   concurrency 14           → 256 s wall,   4 failures
 *   concurrency 20           → 4507 s wall, 16 failures
 *
 * So the wall-clock cliff is over-subscription, not raw core count. The cap
 * leaves headroom for the subprocess churn while still using the machine:
 * two spare cores relative to the worker count absorb the forks.
 *
 * The cap is computed rather than hardcoded, because a CI runner with 2 or
 * 4 cores must not be handed a 6-worker cap — that would put it back on the
 * over-subscribed side of the cliff.
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this script's own location, not the cwd — the
// suite must run against the repo no matter where the command was invoked.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cores = availableParallelism();
const concurrency = Math.max(2, Math.min(cores - 2, 6));

// `--shard 1/2` splits the suite across N runners. The shards are
// independent processes, so two CI runners finish the suite in about half
// the wall clock of one: measured 96.6 s for the whole suite vs 57.7 s and
// 54.6 s for the two halves run side by side.
const shardIndex = process.argv.indexOf("--shard");
const shard = shardIndex >= 0 ? process.argv[shardIndex + 1] : undefined;
if (shardIndex >= 0 && !shard) {
    console.error("--shard needs a value like 1/2");
    process.exit(2);
}

const args = [
    "--experimental-transform-types",
    "--import",
    "./packages/sidecar/tests/_helpers/tsResolveHooks.ts",
    "--import",
    "./packages/sidecar/tests/_helpers/testSetup.ts",
    "--test-force-exit",
    `--test-concurrency=${concurrency}`,
];
if (shard) args.push(`--test-shard=${shard}`);
args.push("--test", "packages/**/tests/**/*.test.ts");

console.log(
    `[test:packages] ${cores} cores → --test-concurrency=${concurrency}` +
        (shard ? `, shard ${shard}` : ""),
);

const child = spawn(process.execPath, args, {
    stdio: "inherit",
    cwd: repo,
});
child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
});
