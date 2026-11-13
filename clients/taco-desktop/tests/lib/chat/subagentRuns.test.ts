import assert from "node:assert/strict";
import { test } from "node:test";
import { asSessionId, asWorkspaceId, type ServerPush } from "@taco-ai/protocol";
import { normalizePushFrame } from "../../../src/hooks/useSidecarStream";
import { getSessionState } from "../../../src/lib/chat/sessionState";
import { deriveSubagents } from "../../../src/lib/chat/subagentList";
import type { WorkspaceState } from "../../../src/lib/chat/workspaceReducer";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    workspacesReducer,
} from "../../../src/lib/chat/workspaceReducer";

const owner = {
    parentSessionId: "parent",
    parentToolCallId: "spawn-1",
    subSessionId: "child",
    agentType: "reviewer",
};
const started = { type: "SUBAGENT_STARTED" as const, cwd: "/w", ...owner, runId: "run-new" };
const settled = {
    type: "SUBAGENT_SETTLED" as const,
    cwd: "/w",
    ...owner,
    outcome: "completed" as const,
};

function initial(): Record<string, WorkspaceState> {
    const ws = createEmptyWorkspace("/w");
    ws.activeSession = "parent";
    ws.messages = [
        {
            id: "spawn",
            kind: "assistant",
            ts: 1,
            text: "",
            thinking: [],
            tools: [
                {
                    id: "spawn-1",
                    name: "agent",
                    args: { description: "review" },
                    status: "ok",
                    details: { subSessionId: "child", status: "completed" },
                },
            ],
        },
    ];
    ws.subagentSpawned = {
        "parent:spawn-1": {
            subSessionId: "child",
            agentType: "reviewer",
            parentToolCallId: "spawn-1",
        },
    };
    ws.backgroundSubagents = { "spawn-1": "completed" };
    return { "/w": ws };
}

function row(state: ReturnType<typeof initial>) {
    assert.ok(state, "lifecycle action must return workspace state");
    const parent = getSessionState(state["/w"], "parent");
    assert.ok(parent);
    const entries = deriveSubagents(parent.messages, parent.backgroundSubagents);
    assert.equal(entries.length, 1);
    return entries[0];
}

test("started -> old settled -> current settled updates only the existing execution", () => {
    const before = initial();
    let state = workspacesReducer(before, started);
    assert.ok(state, "started must return workspace state");
    const parent = getSessionState(state["/w"], "parent");
    assert.equal(row(state)?.status, "background");
    assert.equal(parent?.backgroundRunIds["spawn-1"], "run-new");
    assert.deepEqual(parent?.agentToolPending, {});
    assert.deepEqual(state["/w"].subagentSpawned, before["/w"].subagentSpawned);
    assert.equal(
        getSessionState(state["/w"], "child"),
        undefined,
        "started must not attach a child",
    );
    const card = parent?.messages[0];
    assert.equal(card?.kind === "assistant" && card.tools[0]?.status, "running");
    assert.equal(
        before["/w"].messages[0]?.kind === "assistant" && before["/w"].messages[0].tools[0]?.status,
        "ok",
    );

    for (const runId of ["run-old", undefined]) {
        const stale = workspacesReducer(state, { ...settled, runId, outcome: "error" });
        assert.equal(stale, state);
        assert.equal(row(stale)?.status, "background");
    }
    state = workspacesReducer(state, { ...settled, runId: "run-new", outcome: "aborted" });
    assert.equal(row(state)?.status, "aborted");
    const done = getSessionState(state["/w"], "parent")?.messages[0];
    assert.equal(
        done?.kind === "assistant" && (done.tools[0]?.details as { status: string }).status,
        "aborted",
    );
    assert.equal(
        workspacesReducer(state, started),
        state,
        "replayed started must not resurrect a completed run",
    );
    assert.equal(workspacesReducer(state, { ...settled, runId: "run-new" }), state);

    state = workspacesReducer(state, { ...started, runId: "run-next" });
    assert.equal(row(state)?.status, "background");
    assert.equal(workspacesReducer(state, { ...settled, runId: "run-new" }), state);
    state = workspacesReducer(state, { ...settled, runId: "run-next" });
    assert.equal(row(state)?.status, "ok");
});

test("started requires existing matching ownership and never creates or reparents a child", () => {
    for (const patch of [
        { parentSessionId: "other" },
        { subSessionId: "other-child" },
        { parentToolCallId: "send-call" },
        { runId: "" },
    ]) {
        const state = initial();
        assert.equal(workspacesReducer(state, { ...started, ...patch }), state);
    }
    const state = { "/w": createEmptyWorkspace("/w") };
    assert.equal(workspacesReducer(state, started), state);
    const conflict = initial();
    conflict["/w"].subagentSpawned["parent:spawn-1"].subSessionId = "another-child";
    assert.equal(workspacesReducer(conflict, started), conflict);
});

test("started can recover ownership from an existing historical card without a spawned push", () => {
    const state = initial();
    state["/w"].subagentSpawned = {};
    const next = workspacesReducer(state, started);
    assert.equal(row(next)?.status, "background");
    assert.deepEqual(next["/w"].subagentSpawned, {});
});

test("started stays with its parent across selection and old frames cannot complete another parent", () => {
    let state = workspacesReducer(initial(), { type: "SELECT_SESSION", cwd: "/w", sid: "other" });
    state = workspacesReducer(state, started);
    assert.equal(row(state)?.status, "background");
    assert.deepEqual(state["/w"].backgroundSubagents, {});
    assert.equal(
        workspacesReducer(state, { ...settled, parentSessionId: "other", runId: "run-new" }),
        state,
    );
    state = workspacesReducer(state, { ...settled, runId: "run-new" });
    assert.equal(row(state)?.status, "ok");
});

test("wire started and settled retain run identity through normalization", () => {
    let state = initial();
    for (const [method, params, expected] of [
        ["subagent.started", { ...owner, runId: "run-new" }, "background"],
        ["subagent.settled", { ...owner, runId: "run-old", outcome: "error" }, "background"],
        ["subagent.settled", { ...owner, runId: "run-new", outcome: "completed" }, "ok"],
    ] as const) {
        const frame: ServerPush = {
            method,
            workspace: asWorkspaceId("/w"),
            session: asSessionId("parent"),
            params,
        };
        normalizePushFrame(frame, (action) => {
            state = workspacesReducer(state, action as WorkspaceAction);
        });
        assert.equal(row(state)?.status, expected);
    }
});

test("attach restores active continuation runs after historical background completion", () => {
    for (const active of [true, false]) {
        const state = initial();
        const messages = state["/w"].messages;
        state["/w"].activeSession = "other";
        state["/w"].loadingSessionId = "parent";
        const next = workspacesReducer(state, {
            type: "ATTACH",
            cwd: "/w",
            sid: "parent",
            messages,
            makeActive: active,
            inFlightAgentToolCallIds: [],
            settledBackgroundSubSessionIds: ["child"],
            activeSubagentChatRuns: [
                {
                    ...owner,
                    parentSessionId: asSessionId("parent"),
                    subSessionId: asSessionId("child"),
                    runId: "run-new",
                },
                {
                    ...owner,
                    parentSessionId: asSessionId("parent"),
                    subSessionId: asSessionId("unknown-child"),
                    parentToolCallId: "unknown-spawn",
                    runId: "unknown-run",
                },
            ],
        });
        assert.equal(row(next)?.status, "background");
        assert.equal(getSessionState(next["/w"], "parent")?.backgroundRunIds["spawn-1"], "run-new");
        assert.deepEqual(next["/w"].subagentSpawned, state["/w"].subagentSpawned);
        assert.equal(workspacesReducer(next, { ...settled, runId: "old" }), next);
        assert.equal(row(workspacesReducer(next, { ...settled, runId: "run-new" }))?.status, "ok");
    }
});

test("authoritative runtime snapshot restores active continuation identity", () => {
    const state = initial();
    const next = workspacesReducer(state, {
        type: "RESTORE_SESSION_SNAPSHOT",
        cwd: "/w",
        sid: "parent",
        sessionKind: "main",
        messages: state["/w"].messages,
        runtime: {
            operation: null,
            tools: [],
            queues: [],
            pendingCommandPermissions: [],
            inFlightAgentToolCallIds: [],
            settledBackgroundSubSessionIds: ["child"],
            pendingAskUserToolCallIds: [],
            activeSubagentChatRuns: [
                {
                    ...owner,
                    parentSessionId: asSessionId("parent"),
                    subSessionId: asSessionId("child"),
                    runId: "run-new",
                },
            ],
        },
    });
    assert.equal(row(next)?.status, "background");
    assert.equal(workspacesReducer(next, { ...settled, runId: "old" }), next);
});

test("late queued receipt inherits its already settled continuation without resurrecting it", () => {
    const state = initial();
    const parent = state["/w"].messages[0];
    assert.equal(parent.kind, "assistant");
    if (parent.kind !== "assistant") return;
    parent.tools.push({
        id: "send-1",
        name: "chatToAgent",
        status: "running",
        args: { subSessionId: "child", prompt: "continue" },
    });
    let next = workspacesReducer(state, { ...started, messageId: "message-1" });
    next = workspacesReducer(next, { ...settled, runId: "run-new" });
    next = workspacesReducer(next, {
        type: "APPLY_EVENT",
        cwd: "/w",
        sid: "parent",
        now: 2,
        suppressedThinking: false,
        ev: {
            type: "tool_end",
            toolCallId: "send-1",
            toolName: "chatToAgent",
            result: {
                details: {
                    subSessionId: "child",
                    messageId: "message-1",
                    status: "queued",
                    effectiveDelivery: "queued",
                },
            },
        },
    });
    const message = getSessionState(next["/w"], "parent")?.messages[0];
    assert.equal(message?.kind, "assistant");
    if (message?.kind !== "assistant") return;
    assert.equal((message.tools[1].details as { status: string }).status, "completed");
    assert.equal((message.tools[1].details as { runId: string }).runId, "run-new");
    assert.deepEqual(getSessionState(next["/w"], "parent")?.agentToolPending, {});
});

test("queued message starts by message identity without adopting another message's run", () => {
    const state = initial();
    const parent = state["/w"].messages[0];
    if (parent.kind !== "assistant") return;
    parent.tools.push(
        ...["message-1", "message-2"].map((messageId) => ({
            id: messageId,
            name: "chatToAgent",
            args: { subSessionId: "child" },
            status: "ok" as const,
            details: { subSessionId: "child", messageId, status: "queued" },
        })),
    );
    const next = workspacesReducer(state, { ...started, messageId: "message-1" });
    const message = getSessionState(next["/w"], "parent")?.messages[0];
    if (message?.kind !== "assistant") return assert.fail("missing assistant");
    assert.equal((message.tools[1].details as { status: string }).status, "started");
    assert.equal((message.tools[1].details as { runId: string }).runId, "run-new");
    assert.equal((message.tools[2].details as { status: string }).status, "queued");
});

test("peer sender receives continuation state without gaining child ownership", () => {
    let state = initial();
    state = workspacesReducer(state, {
        type: "CHILD_MESSAGE_EVENT",
        cwd: "/w",
        subSessionId: "peer",
        now: 2,
        suppressedThinking: false,
        ev: {
            type: "message_end",
            message: {
                role: "assistant",
                timestamp: 2,
                content: [{ type: "text", text: "" }],
            },
        },
    });
    state = workspacesReducer(state, {
        type: "CHILD_MESSAGE_EVENT",
        cwd: "/w",
        subSessionId: "peer",
        now: 3,
        suppressedThinking: false,
        ev: {
            type: "tool_start",
            toolCallId: "send-peer",
            toolName: "chatToAgent",
            args: { subSessionId: "child", prompt: "check" },
        },
    });
    state = workspacesReducer(state, {
        type: "CHILD_MESSAGE_EVENT",
        cwd: "/w",
        subSessionId: "peer",
        now: 4,
        suppressedThinking: false,
        ev: {
            type: "tool_end",
            toolCallId: "send-peer",
            toolName: "chatToAgent",
            result: {
                details: {
                    subSessionId: "child",
                    messageId: "msg-peer",
                    status: "queued",
                    effectiveDelivery: "queued",
                },
            },
        },
    });
    state = workspacesReducer(state, { ...started, messageId: "msg-peer" });
    state = workspacesReducer(state, { ...settled, runId: "run-new" });
    const peer = getSessionState(state["/w"], "peer");
    const call = peer?.messages
        .flatMap((m) => (m.kind === "assistant" ? m.tools : []))
        .find((t) => t.id === "send-peer");
    assert.equal((call?.details as { status: string }).status, "completed");
    assert.equal((call?.details as { runId: string }).runId, "run-new");
    assert.deepEqual(peer?.agentToolPending, {});
    assert.deepEqual(peer?.backgroundSubagents, {});
});

test("peer propagation leaves an unrelated agent with the same tool call id untouched", () => {
    let state = workspacesReducer(initial(), { type: "SELECT_SESSION", cwd: "/w", sid: "parent" });
    const parent = getSessionState(state["/w"], "parent");
    assert.ok(parent);
    const peer = {
        ...parent,
        kind: "subagent" as const,
        backgroundSubagents: {},
        backgroundRunIds: {},
        messages: [
            {
                id: "peer",
                kind: "assistant" as const,
                text: "",
                ts: 2,
                thinking: [],
                tools: [
                    {
                        id: "spawn-1",
                        name: "agent",
                        args: {},
                        status: "running" as const,
                        details: {
                            subSessionId: "unrelated-child",
                            runId: "unrelated-run",
                            status: "started",
                        },
                    },
                    {
                        id: "send-peer",
                        name: "chatToAgent",
                        args: { subSessionId: "child" },
                        status: "ok" as const,
                        details: {
                            subSessionId: "child",
                            messageId: "peer-message",
                            runId: "run-new",
                            status: "queued",
                        },
                    },
                ],
            },
        ],
    };
    state["/w"].sessionStatesById = { ...state["/w"].sessionStatesById, peer };
    state = workspacesReducer(state, { ...started, messageId: "peer-message" });
    state = workspacesReducer(state, { ...settled, runId: "run-new" });
    const updated = getSessionState(state["/w"], "peer")?.messages[0];
    if (updated?.kind !== "assistant") return assert.fail("missing peer");
    assert.equal(updated.tools[0], peer.messages[0].tools[0]);
    assert.equal((updated.tools[1].details as { status: string }).status, "completed");
});
