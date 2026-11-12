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
