import assert from "node:assert/strict";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { operationResult } from "@taco-ai/pi-harness/harness/session";
import { asWorkspaceId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import type { WorkOperationRef } from "../../src/work/workOperationTypes.ts";
import { WorkService } from "../../src/work/workService.ts";

export interface WorkCrashReady {
    type: "ready";
    workId: string;
    attemptId: string;
    operation: WorkOperationRef;
    laterOperationId: string;
    runStarts: number;
}

const [root, resultText] = process.argv.slice(2);
assert.ok(root && resultText);
const env = new NodeExecutionEnv({ cwd: root });
const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(root, "sessions") });
const session = await repo.create({ cwd: root }, harnessContext);
const faux = fauxProvider({ provider: "work-crash-test", tokensPerSecond: 0 } as never);
faux.setResponses([
    fauxAssistantMessage([fauxText(resultText)]),
    fauxAssistantMessage([fauxText("An unrelated later reply, not the Work result")]),
] as never);
const models = createModels();
models.setProvider(faux.provider);
const attached = await AttachedSession.create({
    session,
    sessionKind: "main",
    models,
    model: faux.getModel(),
    env,
    systemPrompt: "test",
    tools: [],
    resources: {},
    streamOptions: {},
    taskStore: { currentListId: null, lists: new Map() },
    planState: createPlanModeState(),
    tasksDir: join(root, "tasks"),
    attachmentsDir: join(root, "attachments"),
    sessionCwd: asWorkspaceId(root),
    getToolContext: () => ({ env, workspace: asWorkspaceId(root) }),
});
let runStarts = 0;
attached.on("event", (event) => {
    if (event.type === "run_start") runStarts++;
});
const work = new WorkService({
    root: join(root, "work"),
    instanceId: "crashed-daemon",
    channels: {
        sendText: async () => ({ kind: "confirmed" }),
        maxMessageLength: () => 2000,
    },
    resolveRoute: () => undefined,
});
const started = await work.controller.startScheduled({
    sourceEventId: "job:crash:fire-1",
    jobId: "crash",
    title: "Persisted result before Work settlement",
    workspace: root,
    sessionId: session.metadata.id,
});
const message = await work.run(started.workId, session.metadata.id, async () => {
    const reply = await attached.prompt("Produce the managed Work result");
    const record = await work.store.get(started.workId);
    assert.equal(record?.status, "running");
    assert.equal(record.result, undefined);
    assert.ok(record.attempt.operationAccepted);
    const operation = record.attempt.operation;
    assert.ok(operation);
    const laterOperationId = uuidv7();
    await attached.prompt("Produce an unrelated reply", undefined, undefined, undefined, {
        operationId: laterOperationId,
    });

    // A separate repository must see the result before the parent is allowed to kill us.
    const diskRepo = new JsonlSessionRepo({
        fileSystem: env,
        sessionsRoot: join(root, "sessions"),
    });
    const diskSession = await diskRepo.open(session.metadata, harnessContext);
    try {
        assert.equal(
            (await diskSession.getValue(operationResult(operation.operationId), harnessContext))
                ?.value.status,
            "completed",
        );
        assert.equal(
            (await diskSession.getValue(operationResult(laterOperationId), harnessContext))?.value
                .status,
            "completed",
        );
    } finally {
        await diskRepo.close(harnessContext);
    }
    const ready: WorkCrashReady = {
        type: "ready",
        workId: record.workId,
        attemptId: record.attempt.attemptId,
        operation,
        laterOperationId,
        runStarts,
    };
    // The IPC listener keeps this exact crash window open without polling or sleeps.
    const release = new Promise<void>((resolve) => process.once("message", () => resolve()));
    assert.ok(process.send);
    process.send(ready);
    await release;
    return reply;
});
// SIGKILL must prevent this ordinary post-prompt settlement from ever running.
await work.onFireSettle(started.workId, {
    outcome: "completed",
    replyText:
        message.role === "assistant"
            ? message.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n")
            : "",
});
throw new Error("parent released the crash barrier instead of killing the child");
