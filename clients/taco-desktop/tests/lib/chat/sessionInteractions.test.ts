import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { UiMessage } from "../../../src/lib/chat/chatUtils";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    workspacesReducer,
} from "../../../src/lib/chat/workspaceReducer";

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
    assert.deepEqual(state["/w"].askUserPending, { same: true });
    state = workspacesReducer(state, {
        type: "ASKUSER_ANSWERED",
        cwd: "/w",
        sid: "a",
        toolCallId: "same",
        answers: { a: "yes" },
    }) as typeof state;
    assert.deepEqual(state["/w"].askUserPending, { same: true });
    state = workspacesReducer(state, { type: "ATTACH_START", cwd: "/w", sid: "a" }) as typeof state;
    state = workspacesReducer(state, attach("a")) as typeof state;
    assert.deepEqual(state["/w"].askUserPending, {});
    const message = state["/w"].messages.find((m) => m.kind === "assistant");
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
    const state = {
        "/w": {
            ...createEmptyWorkspace("/w"),
            activeSession: "a",
            messages,
            childMessagesBySubSessionId: { child: messages },
            childHistoryLoaded: { child: messages },
        },
    };
    const ws = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/w" })["/w"];
    assert.ok(ws);
    for (const list of [
        ws.messages,
        ws.childMessagesBySubSessionId.child ?? [],
        ws.childHistoryLoaded.child ?? [],
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
            sessionInteractions: {
                a: { messages: questionMessages(true), askUserPending: { same: true as const } },
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
    assert.deepEqual(ws?.askUserPending, {});
    const m = ws?.messages[0];
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
            sessionInteractions: {
                a: { messages: questionMessages(true), askUserPending: { same: true as const } },
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
    assert.deepEqual(ws?.askUserPending, { same: true });
    assert.equal(
        ws?.messages.some((m) => m.kind === "assistant" && m.tools.some((t) => t.id === "same")),
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
    const messages = state["/w"].messages;
    state = workspacesReducer(state, {
        type: "APPLY_EVENT",
        cwd: "/other",
        sid: "same",
        now: 2,
        suppressedThinking: false,
        ev: { type: "message_end", message: { role: "user", timestamp: 2, content: "two" } },
    }) as typeof state;
    assert.equal(state["/w"].messages, messages);
    const canonical = (
        state["/w"] as unknown as { sessionStatesById?: Record<string, { messages: UiMessage[] }> }
    ).sessionStatesById;
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
        state["/w"].messages.map((m) => m.kind === "user" && m.text),
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
            askUserPending: { same: true as const },
        },
    };
    const ws = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/w" })["/w"];
    assert.ok(ws);
    assert.deepEqual(ws.pendingBySessionId, {});
    assert.deepEqual(ws.queuedBySessionId, {});
    assert.deepEqual(ws.askUserPending, {});
});
