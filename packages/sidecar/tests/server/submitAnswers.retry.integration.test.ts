import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState, enterPlanMode } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, LaneBusy, value } from "../../src/runtime/pi/values.ts";
import { findBranchEntries } from "../../src/runtime/session/sessionBranch.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { createAskUserTool } from "../../src/tools/askUser.ts";
import { createPlanExitTool } from "../../src/tools/planExit.ts";
import type { WorkRecord } from "../../src/work/workTypes.ts";

async function fixture(toolName: "askUser" | "planExit" = "askUser") {
    const root = await mkdtemp(join(tmpdir(), "taco-answer-retry-"));
    if (toolName === "planExit") {
        await mkdir(join(root, ".taco", "plans"), { recursive: true });
        await writeFile(join(root, ".taco", "plans", "approval-plan.md"), "# Approved work\n");
    }
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(root, "sessions") });
    const provider = fauxProvider({ provider: "answer-retry", tokensPerSecond: 0 });
    provider.setResponses([
        fauxAssistantMessage([
            {
                type: "toolCall",
                id: "question",
                name: toolName,
                arguments:
                    toolName === "planExit"
                        ? { planSlug: "approval-plan" }
                        : {
                              questions: [
                                  {
                                      question: "Choose?",
                                      header: "Choice",
                                      multiSelect: false,
                                      options: [
                                          { label: "A", description: "First" },
                                          { label: "B", description: "Second" },
                                      ],
                                  },
                              ],
                          },
            },
        ]),
        fauxAssistantMessage("Done"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    let session = await repo.create({ cwd: root }, harnessContext);
    const metadata = session.metadata;
    const attach = () => {
        const planState = createPlanModeState();
        if (toolName === "planExit") enterPlanMode(planState, "approval-plan");
        return AttachedSession.create({
            session,
            sessionKind: "main",
            models,
            model: provider.getModel(),
            env,
            systemPrompt: "test",
            tools: [
                toolName === "planExit" ? createPlanExitTool(planState, root) : createAskUserTool(),
            ],
            resources: {},
            streamOptions: {},
            taskStore: {
                lists: new Map(),
                getTaskState: () => ({ planMode: false }),
                setTaskState: () => {},
            } as never,
            planState,
            tasksDir: root,
            attachmentsDir: root,
            sessionCwd: asWorkspaceId(root),
            getToolContext: () => ({ env, workspace: asWorkspaceId(root) }) as never,
            compaction: { enabled: false } as never,
        });
    };
    let attached = await attach();
    assert.equal((await attached.prompt("Ask a question")).role, "toolResult");
    const host = () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        server.ensureWorkspace = async () =>
            ({
                workspaceKey: asWorkspaceId(root),
                getAttached: () => attached,
                invalidateListCache: () => {},
                publishCurrentPlanSnapshot: () => {},
            }) as never;
        return server;
    };
    let server = host();
    let nextId = 0;
    return {
        models,
        provider,
        get attached() {
            return attached;
        },
        get work() {
            return server.work;
        },
        async submit(answers: Record<string, string | string[]> = { "Choose?": "A" }) {
            return server.handleRpcRequest({
                id: `answer-${nextId++}`,
                method: "session.submitAnswers",
                params: {
                    workspace: asWorkspaceId(root),
                    sessionId: asSessionId(metadata.id),
                    toolCallId: "question",
                    toolName,
                    answers,
                },
            });
        },
        async restart() {
            await server.stop();
            await attached.dispose();
            await session.close(harnessContext);
            session = await repo.open(metadata, harnessContext);
            attached = await attach();
            server = host();
        },
        async close() {
            await server.stop();
            await attached.dispose();
            await session.close(harnessContext);
            await rm(root, { recursive: true, force: true });
        },
    };
}

type RetryFixture = Awaited<ReturnType<typeof fixture>>;
type StoredReceipt = {
    operationId: string;
    status: string;
    work?: { workId: string; attemptId: string };
};

async function waitingWork(f: RetryFixture) {
    const { id: sessionId, cwd: workspace } = f.attached.session.metadata;
    assert.ok(workspace);
    const work = await f.work.controller.startScheduled({
        sourceEventId: `retry:${sessionId}`,
        jobId: "retry",
        title: "Retry question",
        workspace,
        sessionId,
    });
    await f.work.controller.waitForInput(work.workId, {
        toolCallId: "question",
        toolName: "askUser",
        sessionId,
    });
    return work;
}

async function crashBoundAnswer(f: RetryFixture) {
    const work = await waitingWork(f);
    let admitted: WorkRecord | undefined;
    f.attached.prompt = async () => {
        admitted = await f.work.store.get(work.workId);
        assert.ok(admitted);
        const receipts = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.deepEqual(receipts[0].value.work, {
            workId: work.workId,
            attemptId: admitted.attempt.attemptId,
        });
        throw new Error("simulated crash before prompt admission");
    };
    assert.equal((await f.submit()).ok, false);
    assert.ok(admitted);
    const snapshot = admitted;
    // Restore the durable snapshot at the crash point, before error cleanup.
    await f.work.store.mutate(work.workId, () => ({
        ...snapshot,
        status: "interrupted",
        endedAt: Date.now(),
        reason: "daemon restart",
    }));
    const receipts = await f.attached.session.scanValues(
        value<StoredReceipt>("taco.session.answerReceipt"),
        harnessContext,
    );
    assert.equal(receipts[0].value.status, "prepared");
    return { workId: work.workId, receipt: receipts[0].value };
}

it("restores a prepared receipt's bound Work attempt after a preadmission restart", async () => {
    const f = await fixture();
    try {
        const { workId, receipt } = await crashBoundAnswer(f);
        assert.ok(receipt.work);
        await f.restart();
        const records = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.deepEqual(records[0].value.work, receipt.work);
        const result = await f.submit();
        assert.equal(result.ok, true);
        const completed = await f.work.store.get(workId);
        assert.equal(completed?.status, "completed");
        assert.equal(completed?.attempt.attemptId, receipt.work.attemptId);
        assert.equal(completed?.attempt.operation?.operationId, receipt.operationId);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        await f.close();
    }
});

it("rejects a prepared receipt when its bound attempt was cancelled", async () => {
    const f = await fixture();
    try {
        const { workId, receipt } = await crashBoundAnswer(f);
        await f.work.store.mutate(workId, (record) => ({
            ...record,
            status: "cancelled",
            attempt: { ...record.attempt, cancelRequestedAt: Date.now() },
        }));
        await f.restart();
        const result = await f.submit();
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "invalid_state");
        assert.equal(f.provider.state.callCount, 1);
        assert.equal(await f.attached.getOperationResult(receipt.operationId), undefined);
        assert.equal((await f.work.store.get(workId))?.status, "cancelled");
    } finally {
        await f.close();
    }
});

it("acknowledges a completed answer after restart without another model call", async () => {
    const f = await fixture();
    try {
        assert.equal((await f.submit()).ok, true);
        const calls = f.provider.state.callCount;
        await f.restart();
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, calls);
        const conflict = await f.submit({ "Choose?": "B" });
        assert.equal(conflict.ok, false);
        if (!conflict.ok) assert.equal(conflict.error.code, "invalid_state");
        assert.equal(f.provider.state.callCount, calls);
    } finally {
        await f.close();
    }
});

it("joins the same in-flight answer and rejects a competing payload", async () => {
    const f = await fixture();
    let onEntered = () => {};
    let onRelease = () => {};
    const entered = new Promise<void>((resolve) => {
        onEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
        onRelease = resolve;
    });
    f.provider.setResponses([
        async () => {
            onEntered();
            await release;
            return fauxAssistantMessage("Done once");
        },
    ]);
    try {
        const first = f.submit();
        await entered;
        const retry = f.submit();
        const conflict = await f.submit({ "Choose?": "B" });
        assert.equal(conflict.ok, false);
        if (!conflict.ok) assert.equal(conflict.error.code, "invalid_state");
        onRelease();
        assert.equal((await first).ok, true);
        assert.equal((await retry).ok, true);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        onRelease();
        await f.close();
    }
});

it("does not consume an answer when prompt admission is busy", async () => {
    const f = await fixture();
    const initialAttached = f.attached;
    const prompt = initialAttached.prompt;
    initialAttached.prompt = async () => {
        throw new LaneBusy({
            lane: "main",
            operationId: "other",
            operationKind: "run",
            message: "busy",
        });
    };
    try {
        const busy = await f.submit();
        assert.equal(busy.ok, false);
        if (!busy.ok) assert.equal(busy.error.code, "session_busy");
        await f.restart();
        assert.equal((await f.submit({ "Choose?": "B" })).ok, true);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        initialAttached.prompt = prompt;
        await f.close();
    }
});

it("canonicalizes answer object keys while preserving array payloads", async () => {
    const f = await fixture();
    try {
        assert.equal((await f.submit({ "Choose?": "A", Extra: ["one", "two"] })).ok, true);
        const calls = f.provider.state.callCount;
        assert.equal((await f.submit({ Extra: ["one", "two"], "Choose?": "A" })).ok, true);
        const conflict = await f.submit({ "Choose?": "A", Extra: ["two", "one"] });
        assert.equal(conflict.ok, false);
        if (!conflict.ok) assert.equal(conflict.error.code, "invalid_state");
        assert.equal(f.provider.state.callCount, calls);
    } finally {
        await f.close();
    }
});

it("executes a prepared answer after a crash before admission instead of acknowledging it", async () => {
    const f = await fixture();
    f.attached.prompt = async () => {
        throw new Error("stopped before admission");
    };
    try {
        assert.equal((await f.submit()).ok, false);
        assert.equal(f.provider.state.callCount, 1);
        const records = await f.attached.session.scanValues(
            value<{ operationId: string; status: string }>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.equal(records[0].value.status, "prepared");
        assert.equal(await f.attached.getOperationResult(records[0].value.operationId), undefined);
        await f.restart();
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, 2);
        assert.equal(
            (await f.attached.getOperationResult(records[0].value.operationId))?.status,
            "completed",
        );
    } finally {
        await f.close();
    }
});

it("never acknowledges or reaccepts a failed operation after restart", async () => {
    const f = await fixture();
    f.models.deleteProvider(f.provider.provider.id);
    try {
        assert.equal((await f.submit()).ok, false);
        const records = await f.attached.session.scanValues(
            value<{ operationId: string; status: string }>("taco.session.answerReceipt"),
            harnessContext,
        );
        const receipt = records[0].value;
        assert.equal(receipt.status, "prepared");
        assert.equal((await f.attached.getOperationResult(receipt.operationId))?.status, "failed");
        f.models.setProvider(f.provider.provider);
        await f.restart();
        assert.equal((await f.submit()).ok, false);
        assert.equal(f.provider.state.callCount, 1);
        assert.equal((await f.attached.getOperationResult(receipt.operationId))?.status, "failed");
    } finally {
        await f.close();
    }
});

it("refuses to prompt when persisting the prepared receipt fails", async () => {
    const f = await fixture();
    const setValue = f.attached.session.setValue.bind(f.attached.session);
    f.attached.session.setValue = async (address, next, context) => {
        if (address.namespace === "taco.session.answerReceipt")
            throw new Error("receipt write failed");
        return setValue(address, next, context);
    };
    try {
        const result = await f.submit();
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "internal");
        assert.equal(f.provider.state.callCount, 1);
        f.attached.session.setValue = setValue;
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        await f.close();
    }
});

it("maps an expired Work answer to invalid_state over RPC", async () => {
    const f = await fixture();
    try {
        const { id: sessionId, cwd: workspace } = f.attached.session.metadata;
        assert.ok(workspace);
        const work = await f.work.controller.startScheduled({
            sourceEventId: `expired:${sessionId}`,
            jobId: "expired",
            title: "Expired question",
            workspace,
            sessionId,
        });
        await f.work.controller.waitForInput(work.workId, {
            toolCallId: "question",
            toolName: "askUser",
            sessionId,
        });
        await f.work.store.mutate(work.workId, (record) => ({
            ...record,
            expiresAt: Date.now() - 1,
        }));
        const result = await f.submit();
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "invalid_state");
        assert.equal(f.provider.state.callCount, 1);
        assert.equal((await f.work.store.get(work.workId))?.status, "interrupted");
    } finally {
        await f.close();
    }
});

it("replays a prepared receipt after restart using the same completed operation", async () => {
    const f = await fixture();
    const work = await waitingWork(f);
    const setValue = f.attached.session.setValue.bind(f.attached.session);
    f.attached.session.setValue = async (address, next, context) => {
        if (
            address.namespace === "taco.session.answerReceipt" &&
            (next as { status?: string }).status === "completed"
        ) {
            throw new Error("receipt acknowledgement write failed");
        }
        return setValue(address, next, context);
    };
    try {
        assert.equal((await f.submit()).ok, false);
        const records = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.equal(records.length, 1);
        const receipt = records[0].value;
        assert.equal(receipt.status, "prepared");
        assert.ok(receipt.work);
        assert.equal(receipt.work.workId, work.workId);
        assert.ok(await f.attached.getOperationResult(receipt.operationId));
        const calls = f.provider.state.callCount;
        await f.restart();
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, calls);
        assert.equal(
            (await f.work.store.get(work.workId))?.attempt.attemptId,
            receipt.work.attemptId,
        );
        const entries = await findBranchEntries(f.attached.session);
        assert.equal(
            entries.filter((entry) => entry.type === "message" && entry.message.role === "user")
                .length,
            2,
        );
    } finally {
        await f.close();
    }
});

it("repairs a transient Work settlement failure using the receipt's exact completed operation", async () => {
    const f = await fixture();
    const work = await waitingWork(f);
    const settle = f.work.controller.settle.bind(f.work.controller);
    let refused = false;
    f.work.controller.settle = async (args) => {
        if (!refused) {
            refused = true;
            throw new Error("transient Work settlement failure");
        }
        return settle(args);
    };
    try {
        assert.equal((await f.submit()).ok, false);
        const records = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        const receipt = records[0].value;
        assert.equal(receipt.status, "prepared");
        assert.ok(receipt.work);
        assert.equal(receipt.work.workId, work.workId);
        assert.equal(
            (await f.attached.getOperationResult(receipt.operationId))?.status,
            "completed",
        );
        assert.equal((await f.work.store.get(work.workId))?.status, "running");
        const calls = f.provider.state.callCount;
        assert.equal((await f.submit()).ok, true);
        const repaired = await f.work.store.get(work.workId);
        assert.equal(repaired?.status, "completed");
        assert.equal(repaired?.attempt.attemptId, receipt.work.attemptId);
        assert.equal(repaired?.attempt.operation?.operationId, receipt.operationId);
        assert.equal(f.provider.state.callCount, calls);
        const completed = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.equal(completed[0].value.status, "completed");
        assert.equal(
            (await findBranchEntries(f.attached.session)).filter(
                (entry) => entry.type === "message" && entry.message.role === "user",
            ).length,
            2,
        );
    } finally {
        await f.close();
    }
});

it("reads the exact answered operation's partial output on an abort outcome", async () => {
    const f = await fixture();
    const work = await waitingWork(f);
    f.provider.setResponses([fauxAssistantMessage("Partial answer findings")]);
    const prompt = f.attached.prompt.bind(f.attached);
    // Inject the abort outcome after the operation has persisted its reply tip.
    f.attached.prompt = async (...args) => {
        await prompt(...args);
        throw Object.assign(new Error("aborted"), { terminalStatus: "aborted" });
    };
    try {
        assert.equal((await f.submit()).ok, false);
        const result = await f.work.get(work.workId);
        assert.equal(result.work?.status, "cancelled");
        assert.match(result.resultText ?? "", /Partial answer findings/);
        assert.equal((await f.work.store.get(work.workId))?.result?.completeness, "partial");
    } finally {
        await f.close();
    }
});

it("retries the first question's lost acknowledgement without disturbing the next waiting question", async () => {
    const f = await fixture();
    const work = await waitingWork(f);
    f.provider.setResponses([
        fauxAssistantMessage([
            {
                type: "toolCall",
                id: "question-next",
                name: "askUser",
                arguments: {
                    questions: [
                        {
                            question: "Next choice?",
                            header: "Next",
                            multiSelect: false,
                            options: [
                                { label: "C", description: "Third" },
                                { label: "D", description: "Fourth" },
                            ],
                        },
                    ],
                },
            },
        ]),
    ]);
    const setValue = f.attached.session.setValue.bind(f.attached.session);
    f.attached.session.setValue = async (address, next, context) => {
        if (
            address.namespace === "taco.session.answerReceipt" &&
            (next as StoredReceipt).status === "completed"
        ) {
            throw new Error("first answer acknowledgement lost");
        }
        return setValue(address, next, context);
    };
    try {
        assert.equal((await f.submit()).ok, false);
        const records = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        const receipt = records[0].value;
        assert.equal(receipt.status, "prepared");
        assert.ok(receipt.work);
        const waiting = await f.work.store.get(work.workId);
        assert.equal(waiting?.status, "waiting");
        assert.equal(waiting?.waiting?.toolCallId, "question-next");
        assert.equal(waiting?.attempt.attemptId, receipt.work.attemptId);
        assert.equal(
            (await f.attached.getOperationResult(receipt.operationId))?.status,
            "completed",
        );
        const calls = f.provider.state.callCount;
        await f.restart();
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, calls);
        assert.deepEqual(await f.work.store.get(work.workId), waiting);
        const acknowledged = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.equal(acknowledged[0].value.status, "completed");
        assert.deepEqual(acknowledged[0].value.work, receipt.work);
    } finally {
        await f.close();
    }
});

it("recovers the atomically bound operation after a crash before writing the receipt's Work binding", async () => {
    const f = await fixture();
    const work = await waitingWork(f);
    const setValue = f.attached.session.setValue.bind(f.attached.session);
    f.attached.session.setValue = async (address, next, context) => {
        if (address.namespace === "taco.session.answerReceipt" && (next as StoredReceipt).work) {
            throw new Error("stopped before receipt binding write");
        }
        return setValue(address, next, context);
    };
    try {
        assert.equal((await f.submit()).ok, false);
        assert.equal(f.provider.state.callCount, 1);
        const records = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        const receipt = records[0].value;
        assert.equal(receipt.status, "prepared");
        assert.equal(receipt.work, undefined);
        const pending = await f.work.store.get(work.workId);
        assert.equal(pending?.status, "running");
        assert.equal(pending?.attempt.operation?.operationId, receipt.operationId);
        assert.equal(pending?.attempt.interaction?.toolCallId, "question");
        await f.restart();
        assert.equal((await f.submit()).ok, true);
        assert.equal(f.provider.state.callCount, 2);
        const repaired = await f.work.store.get(work.workId);
        assert.equal(repaired?.status, "completed");
        assert.equal(repaired?.attempt.attemptId, pending?.attempt.attemptId);
        assert.equal(repaired?.attempt.operation?.operationId, receipt.operationId);
        const completed = await f.attached.session.scanValues(
            value<StoredReceipt>("taco.session.answerReceipt"),
            harnessContext,
        );
        assert.equal(completed[0].value.status, "completed");
        assert.deepEqual(completed[0].value.work, {
            workId: work.workId,
            attemptId: pending?.attempt.attemptId,
        });
    } finally {
        await f.close();
    }
});

it("keeps plan mode when its Work interaction was cancelled", async () => {
    const f = await fixture("planExit");
    try {
        const work = await waitingWork(f);
        assert.equal(
            (await f.work.cancel(work.workId, work.attempt.attemptId)).outcome,
            "accepted",
        );
        const result = await f.submit({ "Approve this plan?": "Approve" });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "invalid_state");
        assert.deepEqual(f.attached.planState, { active: true, currentSlug: "approval-plan" });
        assert.equal(f.provider.state.callCount, 1);
    } finally {
        await f.close();
    }
});

it("keeps plan mode when the approval receipt cannot be persisted", async () => {
    const f = await fixture("planExit");
    const setValue = f.attached.session.setValue.bind(f.attached.session);
    f.attached.session.setValue = async (address, next, context) => {
        if (address.namespace === "taco.session.answerReceipt") throw new Error("disk full");
        return setValue(address, next, context);
    };
    try {
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, false);
        assert.deepEqual(f.attached.planState, { active: true, currentSlug: "approval-plan" });
        assert.equal(f.provider.state.callCount, 1);
    } finally {
        f.attached.session.setValue = setValue;
        await f.close();
    }
});

it("keeps plan mode on busy admission and applies a prepared approval before the accepted turn", async () => {
    const f = await fixture("planExit");
    const prompt = f.attached.prompt.bind(f.attached);
    f.attached.prompt = async () => {
        throw new LaneBusy({
            lane: "main",
            operationId: "other",
            operationKind: "run",
            message: "busy",
        });
    };
    try {
        const result = await f.submit({ "Approve this plan?": "Approve" });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "session_busy");
        assert.deepEqual(f.attached.planState, { active: true, currentSlug: "approval-plan" });
        f.attached.prompt = prompt;
        f.provider.setResponses([
            () => {
                assert.deepEqual(f.attached.planState, { active: false, currentSlug: null });
                return fauxAssistantMessage("Implementation admitted");
            },
        ]);
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, true);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        f.attached.prompt = prompt;
        await f.close();
    }
});

it("restores a prepared approval after a preadmission restart", async () => {
    const f = await fixture("planExit");
    f.attached.prompt = async () => {
        throw new Error("crash before admission");
    };
    try {
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, false);
        await f.restart();
        f.provider.setResponses([
            () => {
                assert.deepEqual(f.attached.planState, { active: false, currentSlug: null });
                return fauxAssistantMessage("Recovered approved implementation");
            },
        ]);
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, true);
        assert.equal(f.provider.state.callCount, 2);
    } finally {
        await f.close();
    }
});

it("does not approve a replacement plan when retrying a prepared answer", async () => {
    const f = await fixture("planExit");
    const prompt = f.attached.prompt.bind(f.attached);
    f.attached.prompt = async () => {
        throw new Error("stopped before admission");
    };
    try {
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, false);
        enterPlanMode(f.attached.planState, "replacement-plan");
        f.attached.prompt = prompt;
        f.provider.setResponses([
            () => {
                assert.deepEqual(f.attached.planState, {
                    active: true,
                    currentSlug: "replacement-plan",
                });
                return fauxAssistantMessage("The earlier approval does not authorize this plan");
            },
        ]);
        assert.equal((await f.submit({ "Approve this plan?": "Approve" })).ok, true);
        assert.deepEqual(f.attached.planState, { active: true, currentSlug: "replacement-plan" });
    } finally {
        f.attached.prompt = prompt;
        await f.close();
    }
});

it("keeps plan mode for an expired Work answer and for a rejected plan", async () => {
    const f = await fixture("planExit");
    try {
        const work = await waitingWork(f);
        await f.work.store.mutate(work.workId, (record) => ({
            ...record,
            expiresAt: Date.now() - 1,
        }));
        const result = await f.submit({ "Approve this plan?": "Approve" });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "invalid_state");
        assert.deepEqual(f.attached.planState, { active: true, currentSlug: "approval-plan" });
    } finally {
        await f.close();
    }
    const rejected = await fixture("planExit");
    try {
        assert.equal((await rejected.submit({ "Approve this plan?": "Reject" })).ok, true);
        assert.deepEqual(rejected.attached.planState, {
            active: true,
            currentSlug: "approval-plan",
        });
    } finally {
        await rejected.close();
    }
});
