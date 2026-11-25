#!/usr/bin/env node
/**
 * Runs the node:test package suite.
 *
 * Two knobs, both measured rather than guessed.
 *
 * 1. A CONCURRENCY CAP. node's default is `os.availableParallelism()` — one
 *    worker per core. That over-subscribes this suite: most of its cost is
 *    real subprocess spawns (git, daemons, the CLI's own binaries) and each
 *    worker forks children of its own. Measured on a 10-core box:
 *
 *      concurrency 10 (default) → 96–146 s wall, watcher case failed 1/3
 *      concurrency  6           → 106–138 s wall, watcher case failed 0/3
 *      concurrency 14           → 256 s wall,   4 failures
 *      concurrency 20           → 4507 s wall, 16 failures
 *
 *    So the cliff is over-subscription, not raw core count. The cap leaves
 *    headroom for the subprocess churn while still using the machine. It is
 *    computed rather than hardcoded, because a CI runner with 2 or 4 cores
 *    must not be handed a 6-worker cap — that would put it back on the
 *    over-subscribed side of the cliff.
 *
 * 2. A SERIAL SLOT for the fs-event-sensitive file. `workspace.policies.test.ts`
 *    drives a real chokidar watcher and asserts that the OS delivered a
 *    filesystem event. That is a property of the machine, not of the code:
 *    under load the event is sometimes never delivered, and the case then
 *    burns its whole timeout. Running it alone, after the parallel batch, on
 *    an otherwise idle machine removes the contention. Node 22 has no
 *    file-level exclude flag, so the file list is enumerated here.
 *
 * `--shard 1/2` splits the suite across N runners. The shards are
 * independent processes, so two CI runners finish in about half the wall
 * clock of one: measured 96.6 s for the whole suite vs 57.7 s and 54.6 s
 * for the two halves side by side.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this script's own location, not the cwd — the
// suite must run against the repo no matter where the command was invoked.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cores = availableParallelism();
const concurrency = Math.max(2, Math.min(cores - 2, 6));

// The chokidar skill-watcher case: needs an idle machine to receive its fs
// event, so it runs in its own slot after the parallel batch.
const SERIAL_FILES = ["packages/sidecar/tests/runtime/workspace.policies.test.ts"];

const shardIndex = process.argv.indexOf("--shard");
const shard = shardIndex >= 0 ? process.argv[shardIndex + 1] : undefined;
if (shardIndex >= 0 && !shard) {
    console.error("--shard needs a value like 1/2");
    process.exit(2);
}

/** Every `*.test.ts` under a `tests/` directory, matching the old glob. */
function collectTests(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            collectTests(full, out);
        } else if (entry.name.endsWith(".test.ts")) {
            out.push(full);
        }
    }
    return out;
}

function findTestDirs(root, out = []) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        const full = join(root, entry.name);
        if (entry.name === "tests") out.push(full);
        else findTestDirs(full, out);
    }
    return out;
}

const packagesDir = join(repo, "packages");
const allFiles = findTestDirs(packagesDir)
    .flatMap((dir) => collectTests(dir))
    .map((f) => relative(repo, f))
    .sort();

const serial = SERIAL_FILES.filter((f) => allFiles.includes(f));
const parallel = allFiles.filter((f) => !serial.includes(f));

const BASE_ARGS = [
    "--experimental-transform-types",
    "--import",
    "./packages/sidecar/tests/_helpers/tsResolveHooks.ts",
    "--import",
    "./packages/sidecar/tests/_helpers/testSetup.ts",
    // Deliberately NOT --test-force-exit. It makes node exit the process as
    // soon as the root test finishes, which cuts off trailing subtests that
    // are still queued: `memory/dream.test.ts` reported 109 / 82 / 79 tests
    // across three runs with the flag, and a stable 109 without it. The
    // suite still terminates on its own — the keepalive interval in
    // tests/_helpers/testSetup.ts is cleared in the root `after()` hook, so
    // the event loop drains once the last test finishes.
];

function run(fileList, extra = []) {
    return new Promise((resolvePromise) => {
        const args = [
            ...BASE_ARGS,
            `--test-concurrency=${concurrency}`,
            ...extra,
            "--test",
            ...fileList,
        ];
        const child = spawn(process.execPath, args, { stdio: "inherit", cwd: repo });
        child.on("exit", (code, signal) => {
            if (signal) process.kill(process.pid, signal);
            resolvePromise(code ?? 1);
        });
    });
}

console.log(
    `[test:packages] ${cores} cores → --test-concurrency=${concurrency}; ` +
        `${parallel.length} parallel files, ${serial.length} serial` +
        (shard ? `, shard ${shard}` : ""),
);

// The shard split applies to the parallel batch. The serial slot runs on
// the first shard only, so a sharded CI run still executes it exactly once.
let exitCode = 0;
if (shard) {
    exitCode = await run(parallel, [`--test-shard=${shard}`]);
} else {
    exitCode = await run(parallel);
}

const ownsSerial = !shard || shard.startsWith("1/");
if (serial.length > 0 && ownsSerial) {
    console.log(`[test:packages] serial slot: ${serial.join(", ")}`);
    const serialCode = await run(serial);
    if (exitCode === 0) exitCode = serialCode;
}

process.exit(exitCode);
