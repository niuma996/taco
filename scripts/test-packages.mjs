#!/usr/bin/env node
/**
 * Runs the node:test package suite with two measured safeguards.
 *
 * One worker per core over-subscribes this subprocess-heavy suite. On a 10-core
 * box: 6 workers took 106–138 s with watcher failures 0/3; 10 took 96–146 s with
 * failures 1/3; 14 took 256 s with 4 failures; 20 took 4507 s with 16 failures.
 * The computed cap leaves subprocess headroom and scales down for small CI runners.
 *
 * workspace.policies runs serially because its real chokidar watcher needs an
 * idle machine to receive filesystem events reliably under the full suite.
 *
 * --shard 1/2 splits the parallel batch; the serial slot runs only on shard one.
 * Two measured halves took 57.7 s and 54.6 s versus 96.6 s for the whole suite.
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
