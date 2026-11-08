import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { UiMessage } from "../../../src/lib/chat/chatUtils";
import {
    createSessionState,
    getSessionState,
    hasSessionCache,
    mergeSessionHistory,
    SESSION_CACHE_ACTIVE_BYTE_BUDGET,
    SESSION_CACHE_MAX_IDLE,
} from "../../../src/lib/chat/sessionState";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../../../src/lib/chat/workspaceReducer";

type State = Record<string, WorkspaceState>;
const initial = (): State => ({ "/w": createEmptyWorkspace("/w") });
const user = (text: string, ts = 1): UiMessage => ({ id: `m-${ts}`, kind: "user", text, ts });

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

test("UPSERT_WORKSPACE is additive and preserves every existing reference", () => {
    const state = initial();
    assert.equal(workspacesReducer(state, { type: "UPSERT_WORKSPACE", cwd: "/w" }), state);
    const next = workspacesReducer(state, { type: "UPSERT_WORKSPACE", cwd: "/other" });
    assert.equal(next["/w"], state["/w"]);
    assert.ok(next["/other"]);
});

test("cached switching projects the exact canonical arrays and preserves other session references", () => {
    let state = cached(cached(initial(), "a"), "b");
    const a = getSessionState(state["/w"], "a");
    assert.ok(a);
    state = reduce(state, { type: "ATTACH_START", cwd: "/w", sid: "a" });
    assert.equal(state["/w"]?.activeSession, "a");
    assert.equal(state["/w"]?.messages, a.messages);
    assert.equal(hasSessionCache(state["/w"], "a"), true);
    const active = getSessionState(state["/w"], "a");
    state = reduce(state, { type: "APPEND_USER", cwd: "/w", sid: "b", msg: user("background", 2) });
    assert.equal(getSessionState(state["/w"], "a"), active);
    assert.equal(state["/w"]?.messages, a.messages);
    assert.equal(Object.getOwnPropertyDescriptor(state["/w"], "messages")?.set, undefined);
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

test("oversized active single message keeps a bounded tail with explicit incomplete sync", () => {
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
    assert.equal(s.sync, "incomplete");
    assert.equal(s.truncated, true);
    assert.ok(s.cacheBytes <= SESSION_CACHE_ACTIVE_BYTE_BUDGET);
    assert.equal(
        s.messages.at(-1)?.kind === "user" && s.messages.at(-1)?.text.endsWith("TAIL"),
        true,
    );
    assert.equal(hasSessionCache(state["/w"], "a"), false);
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
    assert.deepEqual(state["/w"]?.agentToolPending, {});
    state = reduce(state, { type: "ATTACH_START", cwd: "/w", sid: "a" });
    assert.deepEqual(state["/w"]?.agentToolPending, { same: true });
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
    assert.deepEqual(state["/w"]?.messages, []);
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
    assert.ok(sessions.some((s) => s.truncated && s.sync === "incomplete"));
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
    assert.equal(state["/w"]?.messages[0]?.text, "fresh");
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

test("INIT accepts frozen canonical input without rewriting its projections", () => {
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
