import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyEventToMessages } from "../../../src/lib/chat/applyEventToMessages";
import type { SessionEventLike, UiMessage } from "../../../src/lib/chat/chatUtils";
import {
    createSessionState,
    getSessionState,
    hasSessionCache,
    mergeSessionHistory,
    SESSION_CACHE_ACTIVE_BYTE_BUDGET,
    SESSION_CACHE_MAX_IDLE,
    transcriptBytes,
} from "../../../src/lib/chat/sessionState";
import { attachAskUserAnswers } from "../../../src/lib/chat/workspaceMessagePatches";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../../../src/lib/chat/workspaceReducer";

type State = Record<string, WorkspaceState>;
const initial = (): State => ({ "/w": createEmptyWorkspace("/w") });
const user = (text: string, ts = 1): UiMessage => ({ id: `m-${ts}`, kind: "user", text, ts });

test("workspace creation and transitions expose only canonical session state", () => {
    const ws = createEmptyWorkspace("/w");
    assert.deepEqual(ws.sessionStatesById, {});
    const state = cached(initial(), "a");
    for (const workspace of [ws, state["/w"]]) {
        for (const field of [
            "messages",
            "askUserPending",
            "agentToolPending",
            "backgroundSubagents",
            "backgroundRunIds",
            "sessionInteractions",
            "childMessagesBySubSessionId",
            "childHistoryLoaded",
        ]) {
            assert.equal(Object.hasOwn(workspace, field), false, field);
        }
    }
});

for (const includeMetadata of [false, true]) {
    test(`active uncached session installs history at revision zero (metadata: ${includeMetadata})`, () => {
        let state = reduce(
            initial(),
            { type: "SELECT_SESSION", cwd: "/w", sid: "a" },
            { type: "SET_SESSION_EXECUTION", cwd: "/w", sid: "a", execution: "idle" },
            { type: "ATTACH_START", cwd: "/w", sid: "a" },
        );
        state = reduce(state, {
            type: "ATTACH",
            cwd: "/w",
            sid: "a",
            messages: [user("history")],
            ...(includeMetadata
                ? { execution: "idle" as const, inFlightAgentToolCallIds: [] }
                : {}),
        });
        const session = getSessionState(state["/w"], "a");
        assert.equal(session?.messages[0]?.text, "history");
        assert.equal(session?.historyLoaded, true);
        assert.equal(session?.sync, "current");
    });
}

test("history reconciliation drops pending ids absent from the merged transcript", () => {
    const session = {
        ...createSessionState(),
        revision: 1,
        askUserPending: { orphan: true as const },
    };
    assert.deepEqual(mergeSessionHistory(session, [user("history")]).askUserPending, {});
});

function reduce(state: State, ...actions: WorkspaceAction[]): State {
    return actions.reduce(workspacesReducer, state);
}
function cached(state: State, sid: string, text = sid): State {
    return reduce(
        state,
        {
            type: "RESTORE_SESSION_SNAPSHOT",
            cwd: "/w",
            sid,
            sessionKind: "main",
            messages: [user(text)],
        },
        { type: "SET_SESSION_EXECUTION", cwd: "/w", sid, execution: "idle" },
    );
}

test("selecting a recovered conversation preserves incomplete synchronization and live execution", () => {
    let state = cached(initial(), "a");
    state = reduce(state, { type: "SET_SESSION_SYNC", cwd: "/w", sid: "a", sync: "incomplete" });
    state = reduce(state, { type: "SELECT_SESSION", cwd: "/w", sid: "a" });
    assert.equal(state["/w"]?.activeSession, "a");
    assert.equal(getSessionState(state["/w"], "a")?.sync, "incomplete");
});

test("completion clears recovered operation metadata without touching another operation kind", () => {
    const ws = createEmptyWorkspace("/w");
    ws.sessionStatesById = {
        a: {
            ...createSessionState(),
            operation: { id: "compact", kind: "compaction", startedAt: 1, status: "running" },
        },
    };
    let state: State = { "/w": ws };
    state = reduce(state, { type: "SESSION_OPERATION_FINISHED", cwd: "/w", sid: "a", kind: "run" });
    assert.equal(getSessionState(state["/w"], "a")?.operation?.id, "compact");
    state = reduce(state, {
        type: "SESSION_OPERATION_FINISHED",
        cwd: "/w",
        sid: "a",
        kind: "compaction",
    });
    assert.equal(getSessionState(state["/w"], "a")?.operation, null);
});

test("navigation_end clears only the recovered navigation operation", () => {
    const ws = createEmptyWorkspace("/w");
    ws.sessionStatesById = {
        a: {
            ...createSessionState(),
            operation: { id: "navigate", kind: "navigation", startedAt: 1, status: "running" },
        },
    };
    let state: State = { "/w": ws };
    state = reduce(state, {
        type: "APPLY_EVENT",
        cwd: "/w",
        sid: "a",
        suppressedThinking: false,
        now: 2,
        ev: { type: "navigation_end" },
    });
    assert.equal(getSessionState(state["/w"], "a")?.operation, null);
});

test("UPSERT_WORKSPACE is additive and preserves every existing reference", () => {
    const state = initial();
    assert.equal(workspacesReducer(state, { type: "UPSERT_WORKSPACE", cwd: "/w" }), state);
    const next = workspacesReducer(state, { type: "UPSERT_WORKSPACE", cwd: "/other" });
    assert.equal(next["/w"], state["/w"]);
    assert.ok(next["/other"]);
});

test("cached switching retains the exact canonical arrays and preserves other session references", () => {
    let state = cached(cached(initial(), "a"), "b");
    const a = getSessionState(state["/w"], "a");
    assert.ok(a);
    state = reduce(state, { type: "ATTACH_START", cwd: "/w", sid: "a" });
    assert.equal(state["/w"]?.activeSession, "a");
    assert.equal(getSessionState(state["/w"], "a")?.messages, a.messages);
    assert.equal(hasSessionCache(state["/w"], "a"), true);
    const active = getSessionState(state["/w"], "a");
    state = reduce(state, { type: "APPEND_USER", cwd: "/w", sid: "b", msg: user("background", 2) });
    assert.equal(getSessionState(state["/w"], "a"), active);
    assert.equal(getSessionState(state["/w"], "a")?.messages, a.messages);
    const workspace = state["/w"];
    assert.ok(workspace);
    assert.equal(Object.hasOwn(workspace, "messages"), false);
});

test("idle transcript LRU retains ten and evicted pending slots do not resurrect caches", () => {
    let state = initial();
    for (let i = 0; i < 40; i++) state = cached(state, String(i));
    assert.equal(Object.keys(state["/w"]?.sessionStatesById ?? {}).length, SESSION_CACHE_MAX_IDLE);
    assert.equal(getSessionState(state["/w"], "0"), undefined);
    assert.equal(hasSessionCache(state["/w"], "39"), true);
    state = reduce(state, {
        type: "PLAN_STATE_UPDATED",
        cwd: "/w",
        sid: "39",
        active: true,
        currentSlug: "plan",
    });
    assert.equal(Object.keys(state["/w"]?.sessionStatesById ?? {}).length, SESSION_CACHE_MAX_IDLE);
});

test("waiting, running, incomplete and current sessions are protected from idle eviction", () => {
    let state = cached(
        cached(cached(cached(initial(), "waiting"), "running"), "incomplete"),
        "current",
    );
    state = reduce(
        state,
        { type: "ATTACH_START", cwd: "/w", sid: "current" },
        { type: "SET_SESSION_EXECUTION", cwd: "/w", sid: "running", execution: "running" },
        { type: "SET_SESSION_SYNC", cwd: "/w", sid: "incomplete", sync: "incomplete" },
        {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid: "waiting",
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "tool_end",
                toolCallId: "q",
                toolName: "askUser",
                result: { details: { waiting: true } },
            },
        },
    );
    for (let i = 0; i < 20; i++) state = cached(state, String(i));
    for (const sid of ["waiting", "running", "incomplete", "current"])
        assert.ok(getSessionState(state["/w"], sid));
});

test("oversized active single message keeps a bounded tail without invalidating synchronization", () => {
    let state = initial();
    state = reduce(state, {
        type: "ADD_SESSION",
        cwd: "/w",
        session: { id: "a", createdAt: "2026-01-01" },
    });
    state = reduce(state, {
        type: "APPEND_USER",
        cwd: "/w",
        sid: "a",
        msg: user(`${"x".repeat(SESSION_CACHE_ACTIVE_BYTE_BUDGET * 2)}TAIL`),
    });
    const s = getSessionState(state["/w"], "a");
    assert.ok(s);
    assert.equal(s.sync, "current");
    assert.equal(s.truncated, true);
    assert.ok(s.cacheBytes <= SESSION_CACHE_ACTIVE_BYTE_BUDGET);
    assert.equal(
        s.messages.at(-1)?.kind === "user" && s.messages.at(-1)?.text.endsWith("TAIL"),
        true,
    );
    assert.equal(hasSessionCache(state["/w"], "a"), false);
});

test("reattaching the active session hydrates a truncated cache even when its stream is current", () => {
    let state = reduce(initial(), {
        type: "ADD_SESSION",
        cwd: "/w",
        session: { id: "a", createdAt: "2026-01-01" },
    });
    state = reduce(state, {
        type: "APPEND_USER",
        cwd: "/w",
        sid: "a",
        msg: user(`${"x".repeat(SESSION_CACHE_ACTIVE_BYTE_BUDGET * 2)}TAIL`),
    });
    const tail = getSessionState(state["/w"], "a")?.messages[0]?.text;
    assert.ok(tail);
    const restored = user(`restored-prefix:${tail}`);
    state = reduce(
        state,
        { type: "ATTACH_START", cwd: "/w", sid: "a" },
        { type: "ATTACH", cwd: "/w", sid: "a", messages: [restored] },
    );
    const session = getSessionState(state["/w"], "a");
    assert.equal(session?.messages[0], restored);
    assert.equal(session.truncated, false);
    assert.equal(hasSessionCache(state["/w"], "a"), true);
});

test("child streams arriving before spawn keep their identity while parents switch", () => {
    let state = cached(cached(initial(), "a"), "b");
    state = reduce(
        state,
        {
            type: "CHILD_MESSAGE_EVENT",
            cwd: "/w",
            subSessionId: "child",
            now: 1,
            suppressedThinking: false,
            ev: { type: "message_end", message: { role: "user", timestamp: 1, content: "child" } },
        },
        { type: "ATTACH_START", cwd: "/w", sid: "b" },
        {
            type: "SUBAGENT_SPAWNED",
            cwd: "/w",
            parentSessionId: "a",
            parentToolCallId: "same",
            subSessionId: "child",
            agentType: "explorer",
        },
    );
    assert.equal(getSessionState(state["/w"], "child")?.messages.length, 1);
    assert.deepEqual(getSessionState(state["/w"], "a")?.agentToolPending, { same: true });
    assert.deepEqual(getSessionState(state["/w"], "b")?.agentToolPending, {});
    state = reduce(state, { type: "ATTACH_START", cwd: "/w", sid: "a" });
    assert.deepEqual(getSessionState(state["/w"], "a")?.agentToolPending, { same: true });
    assert.equal(state["/w"]?.subagentSpawned["a:same"]?.subSessionId, "child");
});

test("restart makes all sessions unknown and recovery snapshots cannot infer idle", () => {
    let state = cached(initial(), "a");
    state = reduce(
        state,
        { type: "SET_PENDING", cwd: "/w", sid: "a", pending: true },
        { type: "SIDECAR_RESTARTED", cwd: "/w" },
    );
    assert.equal(getSessionState(state["/w"], "a")?.execution, "unknown");
    assert.equal(getSessionState(state["/w"], "a")?.sync, "recovering");
    state = reduce(state, {
        type: "RESTORE_SESSION_SNAPSHOT",
        cwd: "/w",
        sid: "a",
        sessionKind: "main",
        messages: [user("recovered")],
    });
    assert.equal(getSessionState(state["/w"], "a")?.execution, "unknown");
    assert.equal(state["/w"]?.pendingBySessionId.a, undefined);
});

test("draft identity survives unrelated events and created background sessions", () => {
    let state = reduce(initial(), {
        type: "BEGIN_PENDING_NEW_SESSION",
        cwd: "/w",
        draftId: "draft",
    });
    state = reduce(state, {
        type: "ADD_SESSION",
        cwd: "/w",
        session: { id: "background", createdAt: "2026-01-01" },
        makeActive: false,
    });
    assert.equal(state["/w"]?.draftId, "draft");
    assert.equal(state["/w"]?.activeSession, undefined);
    state = reduce(state, {
        type: "APPEND_USER",
        cwd: "/w",
        sid: "background",
        msg: user("owned"),
    });
    assert.equal(state["/w"]?.activeSession, undefined);
    assert.equal(getSessionState(state["/w"], "background")?.messages.length, 1);
});

test("superseded attach installs its background cache without moving selection", () => {
    let state = cached(initial(), "b");
    state = reduce(state, { type: "ATTACH_START", cwd: "/w", sid: "b" });
    state = reduce(state, {
        type: "ATTACH",
        cwd: "/w",
        sid: "a",
        messages: [user("late a")],
        makeActive: false,
    });
    assert.equal(state["/w"]?.activeSession, "b");
    assert.equal(getSessionState(state["/w"], "a")?.messages[0]?.text, "late a");
});

test("stale history pending ids cannot revive an answer received during the history read", () => {
    let state = reduce(initial(), { type: "ATTACH_START", cwd: "/w", sid: "a" });
    const history: UiMessage[] = [
        {
            id: "history",
            ts: 1,
            kind: "assistant",
            text: "",
            thinking: [],
            tools: [
                {
                    id: "q",
                    name: "askUser",
                    status: "ok",
                    args: {},
                    details: { waiting: true, questions: [{ question: "q" }] },
                },
            ],
        },
    ];
    state = reduce(
        state,
        {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid: "a",
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "message_start",
                message: { role: "assistant", timestamp: 1, content: [] },
            },
        },
        {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid: "a",
            now: 1,
            suppressedThinking: false,
            ev: { type: "tool_start", toolName: "askUser", toolCallId: "q", args: {} },
        },
        {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid: "a",
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "tool_end",
                toolName: "askUser",
                toolCallId: "q",
                result: { details: { waiting: true, questions: [{ question: "q" }] } },
            },
        },
        { type: "ASKUSER_ANSWERED", cwd: "/w", sid: "a", toolCallId: "q", answers: { q: "yes" } },
        { type: "ATTACH", cwd: "/w", sid: "a", messages: history, pendingAskUserIds: ["q"] },
    );
    assert.deepEqual(getSessionState(state["/w"], "a")?.askUserPending, {});
});

test("total protected transcript bytes stay inside the workspace budget", () => {
    let state = initial();
    const text = `${"x".repeat(900_000)}TAIL`;
    for (let i = 0; i < 12; i++) {
        state = reduce(
            state,
            {
                type: "ADD_SESSION",
                cwd: "/w",
                session: { id: String(i), createdAt: "2026-01-01" },
                makeActive: false,
            },
            { type: "APPEND_USER", cwd: "/w", sid: String(i), msg: user(text) },
            { type: "SET_PENDING", cwd: "/w", sid: String(i), pending: true },
        );
    }
    const sessions = Object.values(state["/w"]?.sessionStatesById ?? {});
    assert.equal(sessions.length, 12);
    assert.ok(sessions.reduce((sum, s) => sum + s.cacheBytes, 0) <= 8 * 1024 * 1024);
    assert.ok(sessions.some((s) => s.truncated && s.sync === "current"));
    assert.ok(sessions.every((s) => s.messages.at(-1)?.text.endsWith("TAIL")));
});

test("settled background children update the named parent when tool ids collide", () => {
    let state = cached(cached(initial(), "a"), "b");
    for (const sid of ["a", "b"])
        state = reduce(state, {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid,
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "tool_end",
                toolCallId: "same",
                toolName: "agent",
                result: { details: { status: "launched" } },
            },
        });
    state = reduce(state, {
        type: "SUBAGENT_SETTLED",
        cwd: "/w",
        parentSessionId: "a",
        parentToolCallId: "same",
        outcome: "completed",
    });
    assert.equal(getSessionState(state["/w"], "a")?.backgroundSubagents.same, "completed");
    assert.equal(getSessionState(state["/w"], "b")?.backgroundSubagents.same, "running");
});

test("transport uncertainty marks only its target unknown and incomplete", () => {
    let state = cached(cached(initial(), "a"), "b");
    state = reduce(state, { type: "SET_PENDING", cwd: "/w", sid: "a", pending: true });
    const b = getSessionState(state["/w"], "b");
    const messages = getSessionState(state["/w"], "a")?.messages;
    state = reduce(state, { type: "SESSION_UNCERTAIN", cwd: "/w", sid: "a" });
    assert.equal(getSessionState(state["/w"], "a")?.execution, "unknown");
    assert.equal(getSessionState(state["/w"], "a")?.sync, "incomplete");
    assert.equal(getSessionState(state["/w"], "a")?.messages, messages);
    assert.equal(getSessionState(state["/w"], "b"), b);
    assert.equal(state["/w"]?.pendingBySessionId.a, undefined);
});

test("history that omits a truncated live tail cannot certify a complete cache", () => {
    let state = reduce(initial(), {
        type: "ADD_SESSION",
        cwd: "/w",
        session: { id: "a", createdAt: "2026-01-01" },
    });
    state = reduce(
        state,
        {
            type: "APPEND_USER",
            cwd: "/w",
            sid: "a",
            msg: user(`${"x".repeat(SESSION_CACHE_ACTIVE_BYTE_BUDGET * 2)}TAIL`),
        },
        {
            type: "RESTORE_SESSION_SNAPSHOT",
            cwd: "/w",
            sid: "a",
            sessionKind: "main",
            messages: [],
        },
    );
    assert.equal(getSessionState(state["/w"], "a")?.truncated, true);
    assert.equal(getSessionState(state["/w"], "a")?.sync, "incomplete");
    assert.equal(hasSessionCache(state["/w"], "a"), false);
});

test("same-session attach after daemon replacement actually installs fresh history", () => {
    let state = cached(initial(), "a");
    state = reduce(
        state,
        { type: "ATTACH_START", cwd: "/w", sid: "a" },
        { type: "SIDECAR_RESTARTED", cwd: "/w" },
        { type: "ATTACH_START", cwd: "/w", sid: "a" },
        { type: "ATTACH", cwd: "/w", sid: "a", messages: [user("fresh")] },
    );
    assert.equal(getSessionState(state["/w"], "a")?.messages[0]?.text, "fresh");
    assert.equal(getSessionState(state["/w"], "a")?.execution, "unknown");
});

test("recovery restores full tool details rather than certifying a trimmed tool stub", () => {
    let state = reduce(initial(), {
        type: "ADD_SESSION",
        cwd: "/w",
        session: { id: "a", createdAt: "2026-01-01" },
    });
    const message: UiMessage = {
        id: "m",
        kind: "assistant",
        ts: 1,
        text: "",
        thinking: [],
        tools: [
            {
                id: "tool",
                name: "shell",
                status: "ok",
                args: {},
                resultText: "x".repeat(SESSION_CACHE_ACTIVE_BYTE_BUDGET * 2),
                details: { done: true },
            },
        ],
    };
    state = reduce(state, {
        type: "RESTORE_SESSION_SNAPSHOT",
        cwd: "/w",
        sid: "a",
        sessionKind: "main",
        messages: [message],
    });
    const recovered: UiMessage = {
        ...message,
        tools: [
            {
                ...message.tools[0],
                id: "tool",
                name: "shell",
                status: "ok",
                args: {},
                resultText: "full recovered result",
                details: { done: true },
            },
        ],
    };
    state = reduce(state, {
        type: "RESTORE_SESSION_SNAPSHOT",
        cwd: "/w",
        sid: "a",
        sessionKind: "main",
        messages: [recovered],
    });
    const result = getSessionState(state["/w"], "a")?.messages[0];
    assert.equal(
        result?.kind === "assistant" && result.tools[0]?.resultText,
        "full recovered result",
    );
});

test("INIT accepts frozen canonical input without rewriting session state", () => {
    const state = cached(initial(), "a");
    const ws = state["/w"];
    assert.ok(ws);
    Object.freeze(ws);
    const next = reduce(state, { type: "INIT", workspaces: state });
    assert.equal(getSessionState(next["/w"], "a"), getSessionState(ws, "a"));
});

test("late child history cannot replace an overlapping live assistant bubble", () => {
    let state = reduce(
        initial(),
        {
            type: "CHILD_MESSAGE_EVENT",
            cwd: "/w",
            subSessionId: "child",
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "message_start",
                message: { role: "assistant", timestamp: 1, content: [] },
            },
        },
        {
            type: "CHILD_MESSAGE_EVENT",
            cwd: "/w",
            subSessionId: "child",
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "message_end",
                message: {
                    role: "assistant",
                    timestamp: 1,
                    content: [{ type: "text", text: "live result" }],
                },
            },
        },
    );
    state = reduce(state, {
        type: "LOAD_SUBAGENT_HISTORY",
        cwd: "/w",
        subSessionId: "child",
        messages: [
            { id: "history", kind: "assistant", ts: 1, text: "older", thinking: [], tools: [] },
        ],
    });
    assert.equal(getSessionState(state["/w"], "child")?.messages[0]?.text, "live result");
});

test("history joins agent deliveries by message identity, preserving same-time human input", () => {
    const provenance = {
        messageId: "delivery-1",
        senderSessionId: "parent",
        relation: "parent" as const,
    };
    const live: UiMessage = {
        id: "agent-message-delivery-1",
        kind: "user",
        text: "continue",
        ts: 2,
        agentProvenance: provenance,
    };
    const history: UiMessage[] = [
        { id: "human", kind: "user", text: "continue", ts: 1 },
        {
            id: "stored-delivery",
            kind: "user",
            text: "continue",
            ts: 1,
            agentProvenance: provenance,
        },
    ];
    const result = mergeSessionHistory(
        {
            ...createSessionState(),
            messages: [live],
            messageVersions: { "user:2": 1, "agent-message:delivery-1": 1 },
        },
        history,
    );
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages.filter((m) => m.kind === "user" && m.agentProvenance).length, 1);
});

test("child history can replace cached receipt state from before the read", () => {
    const cached: UiMessage = {
        id: "live",
        kind: "assistant",
        text: "",
        ts: 1,
        thinking: [],
        tools: [
            {
                id: "send",
                name: "chatToAgent",
                args: {},
                status: "ok",
                details: { status: "started" },
            },
        ],
    };
    const history: UiMessage = {
        ...cached,
        id: "stored",
        tools: [{ ...cached.tools[0], details: { status: "completed" } }],
    };
    const ws = createEmptyWorkspace("/w");
    ws.sessionStatesById = {
        child: {
            ...createSessionState(),
            kind: "subagent",
            messages: [cached],
            revision: 3,
            messageVersions: { "assistant:1": 3 },
        },
    };
    const state = workspacesReducer(
        { "/w": ws },
        {
            type: "LOAD_SUBAGENT_HISTORY",
            cwd: "/w",
            subSessionId: "child",
            messages: [history],
            requestRevision: 3,
        },
    );
    const message = getSessionState(state["/w"], "child")?.messages[0];
    assert.equal(
        message?.kind === "assistant" && (message.tools[0].details as { status: string }).status,
        "completed",
    );
});

const waiting = (sid: string): WorkspaceAction => ({
    type: "APPLY_EVENT",
    cwd: "/w",
    sid,
    now: 1,
    suppressedThinking: false,
    ev: {
        type: "tool_end",
        toolName: "askUser",
        toolCallId: "same",
        isError: false,
        result: { details: { waiting: true, questions: [{ question: sid }] } },
    },
});
const attach = (sid: string): WorkspaceAction => ({ type: "ATTACH", cwd: "/w", sid, messages: [] });

test("background main-session interactions survive switching and answers remain session-owned", () => {
    let state = { "/w": { ...createEmptyWorkspace("/w"), activeSession: "a" } };
    for (const sid of ["a", "b"]) {
        state = workspacesReducer(state, {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid,
            now: 1,
            suppressedThinking: false,
            ev: {
                type: "message_start",
                message: { role: "assistant", timestamp: 1, content: [] },
            },
        }) as typeof state;
        state = workspacesReducer(state, {
            type: "APPLY_EVENT",
            cwd: "/w",
            sid,
            now: 1,
            suppressedThinking: false,
            ev: { type: "tool_start", toolCallId: "same", toolName: "askUser", args: {} },
        }) as typeof state;
    }
    state = workspacesReducer(state, waiting("a")) as typeof state;
    state = workspacesReducer(state, waiting("b")) as typeof state;
    state = workspacesReducer(state, { type: "ATTACH_START", cwd: "/w", sid: "b" }) as typeof state;
    state = workspacesReducer(state, attach("b")) as typeof state;
    assert.deepEqual(
        state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.askUserPending,
        { same: true },
    );
    state = workspacesReducer(state, {
        type: "ASKUSER_ANSWERED",
        cwd: "/w",
        sid: "a",
        toolCallId: "same",
        answers: { a: "yes" },
    }) as typeof state;
    assert.deepEqual(
        state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.askUserPending,
        { same: true },
    );
    state = workspacesReducer(state, { type: "ATTACH_START", cwd: "/w", sid: "a" }) as typeof state;
    state = workspacesReducer(state, attach("a")) as typeof state;
    assert.deepEqual(
        state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.askUserPending,
        {},
    );
    const message = state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.messages.find(
        (m) => m.kind === "assistant",
    );
    assert.deepEqual(message?.kind === "assistant" && message.tools[0]?.details, {
        waiting: true,
        questions: [{ question: "a" }],
        answers: { a: "yes" },
    });
});

test("restart retires permission details on parent, child stream, and loaded child history", () => {
    const messages: UiMessage[] = [
        {
            kind: "assistant",
            id: "m",
            ts: 1,
            text: "",
            thinking: [],
            tools: [
                {
                    id: "agent",
                    name: "agent",
                    status: "ok",
                    args: {},
                    details: { commandPermission: { requestId: "dead" }, subSessionId: "child" },
                },
            ],
        },
    ];
    const state: Record<string, WorkspaceState> = {
        "/w": {
            ...createEmptyWorkspace("/w"),
            activeSession: "a",
            sessionStatesById: {
                a: { ...createSessionState(), messages },
                child: { ...createSessionState(), kind: "subagent", messages, historyLoaded: true },
                streaming: { ...createSessionState(), kind: "subagent", messages },
            },
        },
    };
    const ws = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/w" })["/w"];
    assert.ok(ws);
    for (const list of [
        ws.sessionStatesById.a.messages,
        ws.sessionStatesById.child.messages,
        ws.sessionStatesById.streaming.messages,
    ]) {
        const m = list[0];
        assert.equal(
            m?.kind === "assistant" &&
                (m.tools[0]?.details as Record<string, unknown>).commandPermission,
            undefined,
        );
    }
});

function questionMessages(waiting: boolean, answers?: Record<string, string>): UiMessage[] {
    return [
        {
            id: "m",
            kind: "assistant",
            ts: 1,
            text: "",
            thinking: [],
            tools: [
                {
                    id: "same",
                    name: "askUser",
                    args: {},
                    status: "ok",
                    details: {
                        waiting,
                        questions: [{ question: "q" }],
                        ...(answers ? { answers } : {}),
                    },
                },
            ],
        },
    ];
}

test("fresh answered history cannot be made waiting again by an older session cache", () => {
    const state = {
        "/w": {
            ...createEmptyWorkspace("/w"),
            activeSession: "b",
            loadingSessionId: "a",
            sessionStatesById: {
                a: {
                    ...createSessionState(),
                    messages: questionMessages(true),
                    askUserPending: { same: true as const },
                },
            },
        },
    };
    const ws = workspacesReducer(state, {
        type: "ATTACH",
        cwd: "/w",
        sid: "a",
        messages: questionMessages(false, { q: "yes" }),
        pendingAskUserIds: [],
    })["/w"];
    assert.deepEqual(ws?.sessionStatesById.a?.askUserPending, {});
    const m = ws?.sessionStatesById.a?.messages[0];
    assert.equal(
        m?.kind === "assistant" && (m.tools[0]?.details as { waiting: boolean }).waiting,
        false,
    );
});

test("a waiting tool arriving after the history read survives attach", () => {
    const state = {
        "/w": {
            ...createEmptyWorkspace("/w"),
            activeSession: "b",
            loadingSessionId: "a",
            sessionStatesById: {
                a: {
                    ...createSessionState(),
                    messages: questionMessages(true),
                    askUserPending: { same: true as const },
                },
            },
        },
    };
    const ws = workspacesReducer(state, {
        type: "ATTACH",
        cwd: "/w",
        sid: "a",
        messages: [{ kind: "user", id: "old", ts: 0, text: "before waiting" }],
        pendingAskUserIds: [],
    })["/w"];
    assert.deepEqual(ws?.sessionStatesById.a?.askUserPending, { same: true });
    assert.equal(
        ws?.sessionStatesById.a?.messages.some(
            (m) => m.kind === "assistant" && m.tools.some((t) => t.id === "same"),
        ),
        true,
    );
});

test("canonical sessions keep identical ids isolated by workspace and preserve active references", () => {
    let state = {
        "/w": { ...createEmptyWorkspace("/w"), activeSession: "same" },
        "/other": createEmptyWorkspace("/other"),
    };
    state = workspacesReducer(state, {
        type: "APPLY_EVENT",
        cwd: "/w",
        sid: "same",
        now: 1,
        suppressedThinking: false,
        ev: { type: "message_end", message: { role: "user", timestamp: 1, content: "one" } },
    }) as typeof state;
    const messages = state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.messages;
    state = workspacesReducer(state, {
        type: "APPLY_EVENT",
        cwd: "/other",
        sid: "same",
        now: 2,
        suppressedThinking: false,
        ev: { type: "message_end", message: { role: "user", timestamp: 2, content: "two" } },
    }) as typeof state;
    assert.equal(
        state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.messages,
        messages,
    );
    const canonical = state["/w"].sessionStatesById;
    assert.equal(canonical?.same?.messages, messages);
});

test("late attach history retains live non-interactive messages", () => {
    let state = { "/w": { ...createEmptyWorkspace("/w"), activeSession: "b" } };
    state = workspacesReducer(state, { type: "ATTACH_START", cwd: "/w", sid: "a" }) as typeof state;
    state = workspacesReducer(state, {
        type: "APPLY_EVENT",
        cwd: "/w",
        sid: "a",
        now: 2,
        suppressedThinking: false,
        ev: { type: "message_end", message: { role: "user", timestamp: 2, content: "live" } },
    }) as typeof state;
    state = workspacesReducer(state, {
        type: "ATTACH",
        cwd: "/w",
        sid: "a",
        messages: [{ kind: "user", id: "history", ts: 1, text: "old" }],
    }) as typeof state;
    assert.deepEqual(
        state["/w"].sessionStatesById[state["/w"].activeSession ?? ""]?.messages.map(
            (m) => m.kind === "user" && m.text,
        ),
        ["old", "live"],
    );
});

test("restart clears operational state instead of retaining a running pending flag", () => {
    const state = {
        "/w": {
            ...createEmptyWorkspace("/w"),
            activeSession: "a",
            pendingBySessionId: { a: true },
            queuedBySessionId: {
                a: [{ id: "q", text: "do not rerun", kind: "nextRun" as const, optimistic: true }],
            },
            sessionStatesById: {
                a: { ...createSessionState(), askUserPending: { same: true as const } },
            },
        },
    };
    const ws = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/w" })["/w"];
    assert.ok(ws);
    assert.deepEqual(ws.pendingBySessionId, {});
    assert.deepEqual(ws.queuedBySessionId, {});
    assert.deepEqual(ws.sessionStatesById.a.askUserPending, {});
});

function plainUser(text: string, id = "user"): UiMessage {
    return { id, kind: "user", text, ts: 1 };
}

function assistant(): Extract<UiMessage, { kind: "assistant" }> {
    return {
        id: "live-asst-2",
        kind: "assistant",
        ts: 2,
        text: '你好 🌮\n"quoted"\\\t\u0000\ud800',
        thinking: [{ thinking: "café e\u0301", startedAt: 2 }],
        tools: [
            {
                id: "tool",
                name: "askUser",
                status: "running",
                args: { question: "继续？", omitted: undefined },
                resultText: '输出\n"value"\\path',
                details: { nested: [null, true, 3.5, "😀"], waiting: true },
            },
        ],
    };
}

function exactBytes(messages: UiMessage[]): number {
    return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
}

test("transcriptBytes matches JSON UTF-8 bytes including punctuation and nested tool output", () => {
    const messages: UiMessage[] = [
        plainUser("ASCII"),
        assistant(),
        { id: "system", kind: "system", text: "\r\b\f\udfff", ts: 3 },
        { id: "orphan", kind: "tool", text: "工具输出", ts: 4 },
    ];
    assert.equal(transcriptBytes([]), 2);
    for (let length = 1; length <= messages.length; length++) {
        const prefix = messages.slice(0, length);
        assert.equal(transcriptBytes(prefix), exactBytes(prefix));
    }
    const first = messages[0];
    const second = messages[1];
    assert.ok(first && second);
    const repeated = [first, first, second];
    assert.equal(transcriptBytes(repeated), exactBytes(repeated));
});

test("unchanged message objects reuse serialization and encoding across new arrays", (t) => {
    const messages = [plainUser("large history ".repeat(10_000)), assistant()];
    const expected = exactBytes(messages);
    const stringify = t.mock.method(JSON, "stringify");
    const encode = t.mock.method(TextEncoder.prototype, "encode");
    assert.equal(transcriptBytes(messages), expected);
    const serializations = stringify.mock.callCount();
    const encodings = encode.mock.callCount();

    for (let i = 0; i < 10; i++) assert.equal(transcriptBytes([...messages]), expected);

    assert.equal(stringify.mock.callCount(), serializations);
    assert.equal(encode.mock.callCount(), encodings);
});

test("streaming deltas serialize only each changed tail and preserve exact totals", (t) => {
    const history = Array.from({ length: 100 }, (_, i) =>
        plainUser("history".repeat(1_000), `${i}`),
    );
    let messages: UiMessage[] = [...history, assistant()];
    transcriptBytes(messages);
    const originalStringify = JSON.stringify;
    const stringify = t.mock.method(JSON, "stringify");
    const encode = t.mock.method(TextEncoder.prototype, "encode");
    for (let i = 0; i < 20; i++) {
        const before = messages;
        deepFreeze(before);
        messages = applyEventToMessages(
            before,
            {
                type: "message_update",
                message: { role: "assistant", timestamp: 2 },
                assistantMessageEvent: { type: "text_delta", delta: '🌮\n"' },
            },
            { now: 3, suppressedThinking: false },
        ).messages;
        assert.notEqual(messages.at(-1), before.at(-1));
        assert.equal(messages[0], before[0]);
        assert.equal(transcriptBytes(messages), Buffer.byteLength(originalStringify(messages)));
    }
    assert.equal(stringify.mock.callCount(), 20);
    assert.ok(stringify.mock.calls.every((call) => !Array.isArray(call.arguments[0])));
    assert.equal(encode.mock.callCount(), 20);
});

test("thinking, tool updates, completion and answer patches replace measured messages", () => {
    const events: SessionEventLike[] = [
        {
            type: "message_update",
            message: { role: "assistant", timestamp: 2 },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考😀" },
        },
        {
            type: "tool_update",
            toolCallId: "tool",
            partialResult: {
                content: [{ type: "text", text: "更多输出" }],
                details: { waiting: true },
            },
        },
        {
            type: "tool_end",
            toolCallId: "tool",
            toolName: "askUser",
            result: { content: [{ type: "text", text: "完成" }], details: { waiting: true } },
        },
        {
            type: "message_end",
            message: {
                role: "assistant",
                timestamp: 2,
                content: [{ type: "text", text: "最终回复" }],
            },
        },
    ];
    let messages: UiMessage[] = [plainUser("history"), assistant()];
    for (const event of events) {
        const before = messages;
        const previousBytes = transcriptBytes(before);
        const snapshot = JSON.stringify(before);
        deepFreeze(before);
        messages = applyEventToMessages(before, event, {
            now: 3,
            suppressedThinking: false,
        }).messages;
        assert.notEqual(messages[1], before[1]);
        assert.equal(messages[0], before[0]);
        assert.equal(JSON.stringify(before), snapshot);
        assert.equal(transcriptBytes(before), previousBytes);
        assert.equal(transcriptBytes(messages), exactBytes(messages));
    }
    deepFreeze(messages);
    const answered = attachAskUserAnswers(messages, "tool", { answer: "是 ✅" });
    assert.notEqual(answered[1], messages[1]);
    assert.equal(transcriptBytes(answered), exactBytes(answered));
});

test("replacement objects with the same id are remeasured, including shorter tails", () => {
    const first = plainUser("😀".repeat(1_000));
    const shorter = { ...first, text: "x" };
    const appended = plainUser('"\\\n', "new");
    for (const messages of [[first], [shorter], [shorter, appended], [appended], []]) {
        assert.equal(transcriptBytes(messages), exactBytes(messages));
    }
});
