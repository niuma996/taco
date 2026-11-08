import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { operationResult } from "@taco-ai/pi-harness/harness/session";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { Session } from "../../src/runtime/pi/types.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { WorkOperationRef } from "../../src/work/workOperationTypes.ts";
import { workRuntimeAdapter } from "../../src/work/workRuntimeAdapter.ts";
import { WorkService } from "../../src/work/workService.ts";
import type { WorkCrashReady } from "../_helpers/workCrashChild.ts";

async function bounded<T>(promise: Promise<T>, label: string, timeout = 15_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

it("repairs the exact completed operation after SIGKILL without another driver or session write", {
    timeout: 30_000,
}, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-crash-"));
    const resultText = "Managed findings persisted before SIGKILL";
    const child = fork(
        fileURLToPath(new URL("../_helpers/workCrashChild.ts", import.meta.url)),
        [root, resultText],
        {
            execArgv: [
                "--experimental-transform-types",
                "--import",
                new URL("../_helpers/tsResolveHooks.ts", import.meta.url).href,
            ],
            env: { ...process.env, TACO_HOME: join(root, "home") },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
    );
    let diagnostics = "";
    for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8").on("data", (chunk: string) => {
            diagnostics = (diagnostics + chunk).slice(-8000);
        });
    }
    const exited = once(child, "exit");
    const ready = Promise.race([
        once(child, "message").then(([message]) => message as WorkCrashReady),
        exited.then(([code, signal]) => {
            throw new Error(`child exited before readiness (${code}, ${signal}): ${diagnostics}`);
        }),
    ]);
    const repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: root }),
        sessionsRoot: join(root, "sessions"),
    });
    let restarted: WorkService | undefined;
    t.after(async () => {
        restarted?.stop();
        try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            if (child.pid) await bounded(exited, "child cleanup", 5000);
        } finally {
            try {
                await repo.close(harnessContext);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    const checkpoint = await bounded(ready, "operation committed before Work settlement").catch(
        (error: unknown) => {
            throw new Error(`${String(error)}\n${diagnostics}`);
        },
    );
    assert.equal(checkpoint.type, "ready");
    assert.equal(checkpoint.runStarts, 2);
    assert.notEqual(checkpoint.operation.operationId, checkpoint.laterOperationId);
    assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await bounded(exited, "SIGKILL exit");
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");

    const metadata = (await repo.list(undefined, harnessContext)).find(
        (entry) => entry.id === checkpoint.operation.sessionId,
    );
    assert.ok(metadata);
    const beforeBytes = await readFile(metadata.path);
    const session = await repo.open(metadata, harnessContext);
    try {
        const original = (
            await session.getValue(
                operationResult(checkpoint.operation.operationId),
                harnessContext,
            )
        )?.value;
        const later = (
            await session.getValue(operationResult(checkpoint.laterOperationId), harnessContext)
        )?.value;
        assert.equal(original?.status, "completed");
        assert.equal(later?.status, "completed");
        assert.notEqual(original?.tipId, later?.tipId);
    } finally {
        await session.close(harnessContext);
    }

    let reads = 0;
    let driverAttempts = 0;
    const adapter = workRuntimeAdapter(async (workspace) => {
        assert.equal(workspace, root);
        return {
            sessionRegistry: {
                withSession: async <T>(
                    sessionId: string,
                    read: (session: Session) => Promise<T>,
                ) => {
                    assert.equal(sessionId, metadata.id);
                    reads++;
                    const opened = await repo.open(metadata, harnessContext);
                    try {
                        // Expose only the reads needed by the production adapter, never a harness.
                        return await read({
                            getValue: opened.getValue.bind(opened),
                            getEntry: opened.getEntry.bind(opened),
                        } as Session);
                    } finally {
                        await opened.close(harnessContext);
                    }
                },
            },
            getAttached: () => {
                driverAttempts++;
                assert.fail("Work reconciliation must not obtain or drive an attached session");
            },
        } as unknown as WorkspaceRuntime;
    });
    const inspected: WorkOperationRef[] = [];
    restarted = new WorkService({
        root: join(root, "work"),
        instanceId: "restarted-daemon",
        channels: {
            sendText: async () => assert.fail("a scheduled Work must not gain a second notice"),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => undefined,
        operations: {
            inspect: async (ref) => {
                inspected.push(ref);
                return adapter.inspect(ref);
            },
            abort: (ref) => adapter.abort(ref),
        },
    });
    const pending = await restarted.store.get(checkpoint.workId);
    assert.equal(pending?.status, "running");
    assert.equal(pending.result, undefined);
    assert.equal(pending.ownerInstanceId, "crashed-daemon");
    assert.equal(pending.attempt.operationAccepted, true);
    assert.deepEqual(pending.attempt.operation, checkpoint.operation);

    await bounded(restarted.start(), "read-only Work recovery");
    const repaired = await restarted.get(checkpoint.workId);
    assert.equal(repaired.work?.status, "completed");
    assert.equal(repaired.work?.attemptId, checkpoint.attemptId);
    assert.equal(repaired.work?.completeness, "full");
    assert.equal(repaired.resultText, resultText);
    assert.deepEqual(inspected, [checkpoint.operation]);
    assert.equal(reads, 1);
    assert.equal(driverAttempts, 0);
    assert.deepEqual(await readFile(metadata.path), beforeBytes);
    // A second reconciliation must leave the settled attempt and result alone.
    await bounded(restarted.start(), "repeated Work recovery");
    assert.deepEqual(await restarted.get(checkpoint.workId), repaired);
    assert.equal(inspected.length, 1);
    assert.deepEqual(await readFile(metadata.path), beforeBytes);
});
