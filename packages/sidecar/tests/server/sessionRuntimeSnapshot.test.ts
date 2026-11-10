import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSnapshot } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

function fixture(kind: "main" | "subagent" = "main") {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    let seq = 10;
    let watches = 0;
    let unsubscribed = 0;
    let attachCalls = 0;
    let duringRead = () => {};
    const partialMessage = {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        timestamp: 1234,
    };
    const permission = {
        requestId: "permission",
        sessionId: "child",
        displaySessionId: "session",
        toolCallId: "shell",
        command: "pnpm build",
        evaluation: { behavior: "ask", risk: "workspaceWrite", reason: "test" },
    };
    const entries = [
        {
            id: "ask",
            parentId: null,
            type: "message",
            timestamp: 1000,
            message: {
                role: "toolResult",
                toolCallId: "question",
                toolName: "planExit",
                content: [],
                isError: false,
                timestamp: 1000,
                details: { waiting: true, questions: [] },
            },
        },
    ];
    const attached = {
        taskStore: createTaskStore("/workspace"),
        planState: { active: true, currentSlug: "plan" },
        async watchSnapshot() {
            watches++;
            let listener: () => void = () => {};
            return {
                snapshot: {
                    transcript: entries,
                    tipId: "ask",
                    operation: {
                        id: "run",
                        kind: "run",
                        startedAt: 1,
                        status: "running",
                        streamingMessage: partialMessage,
                        retry: { attempt: 2, maxAttempts: 3, nextAttemptAt: 5000 },
                        runningTools: [
                            {
                                toolCallId: "shell",
                                toolName: "bash",
                                args: { command: "pnpm build" },
                                status: "running",
                                result: {
                                    content: [{ type: "text", text: "working" }],
                                    details: { progress: 1 },
                                },
                            },
                        ],
                    },
                    queues: [
                        {
                            entryId: "queued",
                            kind: "steer",
                            type: "message",
                            message: { role: "user", content: "redirect", timestamp: 1002 },
                        },
                    ],
                },
                start(fn: () => void) {
                    listener = fn;
                },
                unsubscribe() {
                    unsubscribed++;
                },
                change() {
                    listener();
                },
            };
        },
    };
    const workspace = {
        listSessions: async () => [{ id: "session" }],
        getSessionFacts: async () => ({ kind }),
        getAttached: ((): typeof attached | undefined => attached),
        attach: async () => assert.fail("snapshot must not attach a session"),
        getHistory: (async () =>
            assert.fail("must use the source watch transcript")) as WorkspaceRuntime["getHistory"],
        inFlightAgentToolCallIds: () => ["agent"],
        async settledBackgroundSubSessionIds() {
            duringRead();
            return ["settled-child"];
        },
        permissionBroker: {
            pendingForSession(sessionId: string) {
                assert.equal(sessionId, "session");
                return seq === 10 ? [permission] : [];
            },
        },
    };
    server.ensureWorkspace = async () => workspace as never;
    server.hydrateSessionEvents = async () => {};
    server.getSessionLastSeq = () => seq;
    async function read() {
        return server.dispatchRpc({
            id: "snapshot",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "session" },
        });
    }
    return {
        server,
        attached,
        workspace,
        read,
        partialMessage,
        permission,
        entries,
        counts: () => ({ watches, unsubscribed }),
        attachCalls: () => attachCalls,
        attachForSnapshot: () => {
            attachCalls++;
            return attached;
        },
        setDuringRead(fn: () => void) {
            duringRead = fn;
        },
        advance() {
            seq++;
        },
    };
}

function result(
    response: Awaited<ReturnType<ReturnType<typeof fixture>["read"]>>,
): SessionSnapshot {
    assert.equal(response.ok, true, JSON.stringify(response));
    return (response as { result: SessionSnapshot }).result;
}

describe("session runtime snapshot", () => {
    it("keeps an unattached main session passive and returns history without runtime", async () => {
        const f = fixture();
        f.workspace.getAttached = () => undefined;
        f.workspace.attach = async () => f.attachForSnapshot() as never;
        f.workspace.getHistory = async () => ({ leafEntryId: null, entries: [] });

        const snapshot = result(await f.read());

        assert.equal(f.attachCalls(), 0);
        assert.equal(snapshot.runtime, undefined);
        assert.deepEqual(snapshot.history.entries, []);
    });

    it("recovers source partial timestamp, tools, queues, interactions and child state", async () => {
        const f = fixture();
        const snapshot = result(await f.read());
        assert.equal(snapshot.history.leafEntryId, "ask");
        assert.deepEqual(snapshot.runtime, {
            operation: {
                id: "run",
                kind: "run",
                startedAt: 1,
                status: "running",
                retry: { attempt: 2, maxAttempts: 3, nextAttemptAt: 5000 },
            },
            partialMessage: f.partialMessage,
            tools: [
                {
                    toolCallId: "shell",
                    toolName: "bash",
                    args: { command: "pnpm build" },
                    status: "running",
                    result: {
                        content: [{ type: "text", text: "working" }],
                        details: { progress: 1 },
                    },
                },
            ],
            queues: [
                {
                    entryId: "queued",
                    kind: "steer",
                    message: { role: "user", content: "redirect", timestamp: 1002 },
                },
            ],
            pendingCommandPermissions: [f.permission],
            inFlightAgentToolCallIds: ["agent"],
            settledBackgroundSubSessionIds: ["settled-child"],
            pendingAskUserToolCallIds: ["question"],
        });
        assert.deepEqual(f.counts(), { watches: 1, unsubscribed: 1 });
    });

    it("copies source state before asynchronous related reads can mutate it", async () => {
        const f = fixture();
        f.setDuringRead(() => {
            assert.ok(f.partialMessage.content[0]);
            f.partialMessage.content[0].text = "changed after capture";
        });
        const snapshot = result(await f.read());
        assert.deepEqual(snapshot.runtime?.partialMessage, {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
            timestamp: 1234,
        });
    });

    it("retries a watch change even when no sequenced frame was emitted", async () => {
        const f = fixture();
        const original = f.attached.watchSnapshot;
        let first = true;
        f.attached.watchSnapshot = async () => {
            const watch = await original();
            f.setDuringRead(() => {
                if (first) {
                    first = false;
                    watch.change();
                }
            });
            return watch;
        };
        const snapshot = result(await f.read());
        assert.equal(snapshot.snapshotSeq, 10);
        assert.deepEqual(f.counts(), { watches: 2, unsubscribed: 2 });
    });

    it("returns explicit idle and empty runtime state to clear stale client data", async () => {
        const f = fixture();
        const original = f.attached.watchSnapshot;
        f.attached.watchSnapshot = async () => {
            const watch = await original();
            Object.assign(watch.snapshot, {
                operation: null,
                queues: [],
                transcript: [],
                tipId: null,
            });
            return watch;
        };
        f.workspace.inFlightAgentToolCallIds = () => [];
        f.workspace.settledBackgroundSubSessionIds = async () => [];
        f.workspace.permissionBroker.pendingForSession = () => [];
        assert.deepEqual(result(await f.read()).runtime, {
            operation: null,
            tools: [],
            queues: [],
            pendingCommandPermissions: [],
            inFlightAgentToolCallIds: [],
            settledBackgroundSubSessionIds: [],
            pendingAskUserToolCallIds: [],
        });
    });

    it("preserves a staged settled tool result and its error flag", async () => {
        const f = fixture();
        const original = f.attached.watchSnapshot;
        f.attached.watchSnapshot = async () => {
            const watch = await original();
            Object.assign(watch.snapshot.operation.runningTools[0], {
                status: "settled",
                isError: true,
            });
            return watch;
        };
        const tool = result(await f.read()).runtime?.tools[0];
        assert.equal(tool?.status, "settled");
        assert.equal(tool?.isError, true);
        assert.deepEqual(tool?.result?.details, { progress: 1 });
    });

    it("redacts source permission commands and partial tool args/results like live pushes", async () => {
        const f = fixture();
        const secret = "ghp_" + "a".repeat(36);
        f.permission.command = `echo ${secret}`;
        const original = f.attached.watchSnapshot;
        f.attached.watchSnapshot = async () => {
            const watch = await original();
            const tool = watch.snapshot.operation.runningTools[0];
            assert.ok(tool);
            tool.args.command = `echo ${secret}`;
            assert.ok(tool.result.content[0]);
            tool.result.content[0].text = secret;
            return watch;
        };
        const runtime = result(await f.read()).runtime;
        assert.ok(runtime);
        assert.ok(!JSON.stringify(runtime).includes(secret));
        const permission = runtime.pendingCommandPermissions[0];
        assert.ok(permission);
        assert.match(permission.command, /REDACTED/);
    });

    it("keeps pre-compaction history when the source transcript starts at compaction", async () => {
        const f = fixture();
        const old = {
            id: "old",
            parentId: null,
            type: "message",
            timestamp: 500,
            message: { role: "user", content: "before compaction", timestamp: 500 },
        };
        f.entries.unshift({
            id: "compaction",
            parentId: "old",
            type: "compaction",
            timestamp: 900,
        } as never);
        Object.assign(f.workspace, {
            getHistory: async () => ({ leafEntryId: "ask", entries: [old, ...f.entries] }),
        });
        const snapshot = result(await f.read());
        assert.deepEqual(
            snapshot.history.entries.map((entry) => entry.id),
            ["old", "compaction", "ask"],
        );
        assert.equal(snapshot.history.leafEntryId, "ask");
    });

    it("recovers an unanswered question preceding a manual compaction", async () => {
        const f = fixture();
        const question = structuredClone(f.entries[0]);
        assert.ok(question);
        question.id = "waiting";
        const compaction = { id: "ask", parentId: "waiting", type: "compaction", timestamp: 1100 };
        f.entries.splice(0, f.entries.length, compaction as never);
        Object.assign(f.workspace, {
            getHistory: async () => ({ leafEntryId: "ask", entries: [question, compaction] }),
        });
        assert.deepEqual(result(await f.read()).runtime?.pendingAskUserToolCallIds, ["question"]);
    });

    it("retains image data and MIME type in source tool result blocks", async () => {
        const f = fixture();
        const original = f.attached.watchSnapshot;
        const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
        f.attached.watchSnapshot = async () => {
            const watch = await original();
            const tool = watch.snapshot.operation.runningTools[0];
            assert.ok(tool);
            tool.result.content.push(image as never);
            return watch;
        };
        assert.deepEqual(result(await f.read()).runtime?.tools[0]?.result?.content[1], image);
    });

    it("retries all runtime and permission reads when the watermark advances", async () => {
        const f = fixture();
        f.setDuringRead(() => {
            f.advance();
            f.setDuringRead(() => {});
        });
        const snapshot = result(await f.read());
        assert.equal(snapshot.snapshotSeq, 11);
        assert.deepEqual(snapshot.runtime?.pendingCommandPermissions, []);
        assert.deepEqual(f.counts(), { watches: 2, unsubscribed: 2 });
    });

    it("unsubscribes on every unstable attempt and reports SnapshotUnstable", async () => {
        const f = fixture();
        f.setDuringRead(() => f.advance());
        const response = await f.read();
        assert.equal(response.ok, false);
        assert.equal((response as { error: { code: string } }).error.code, "snapshot_unstable");
        assert.deepEqual(f.counts(), { watches: 3, unsubscribed: 3 });
    });

    it("unsubscribes when a related runtime read fails", async () => {
        const f = fixture();
        f.setDuringRead(() => {
            throw new Error("read failed");
        });
        assert.equal((await f.read()).ok, false);
        assert.deepEqual(f.counts(), { watches: 1, unsubscribed: 1 });
    });

    it("uses attached child runtime without loading main-session tools or task state", async () => {
        const f = fixture("subagent");
        const snapshot = result(await f.read());
        assert.equal(snapshot.sessionKind, "subagent");
        assert.equal(snapshot.runtime?.operation?.id, "run");
        assert.equal(snapshot.tasks, undefined);
        assert.equal(snapshot.planState, undefined);
    });

    for (const toolName of ["askUser", "planExit"]) {
        it(`clears historical ${toolName} waiting state after later hidden user input`, async () => {
            const f = fixture();
            assert.ok(f.entries[0]);
            f.entries[0].message.toolName = toolName;
            f.entries.push({
                id: "answer",
                parentId: "ask",
                type: "message",
                timestamp: 1001,
                message: {
                    role: "user",
                    content: "<ask_user_context>answered</ask_user_context>",
                    timestamp: 1001,
                },
            } as never);
            const snapshot = result(await f.read());
            assert.deepEqual(snapshot.runtime?.pendingAskUserToolCallIds, []);
        });
    }
});
