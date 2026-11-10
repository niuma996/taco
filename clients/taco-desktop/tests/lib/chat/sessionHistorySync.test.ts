import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage } from "@taco-ai/protocol";
import { type HistoryEntryLike, historyToUiMessages } from "../../../src/lib/chat/chatUtils";
import {
    getSessionState,
    SESSION_CACHE_ACTIVE_BYTE_BUDGET,
} from "../../../src/lib/chat/sessionState";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../../../src/lib/chat/workspaceReducer";

const messageTimestamp = 1_790_000_000_000;
const persistedAt = messageTimestamp + 120_000;
const receivedAt = persistedAt + 50;

const sources = ["stream", "replay", "user", "optimistic", "final"] as const;
const cases = sources.flatMap((source) => {
    const outcomes =
        source === "user" || source === "optimistic"
            ? (["complete"] as const)
            : (["complete", "error", "partial-error"] as const);
    return outcomes.map((outcome) => ({ source, outcome }));
});

for (const { source, outcome } of cases) {
    test(`truncated ${source} ${outcome} messages reconcile with history without duplication`, () => {
        const cwd = "/workspace";
        const sid = "session";
        let state: Record<string, WorkspaceState> = { [cwd]: createEmptyWorkspace(cwd) };
        const dispatch = (action: WorkspaceAction) => {
            state = workspacesReducer(state, action);
        };
        const olderText = `${"x".repeat(SESSION_CACHE_ACTIVE_BYTE_BUDGET * 2)}TAIL`;
        dispatch({ type: "ADD_SESSION", cwd, session: { id: sid, createdAt: "2026-01-01" } });
        dispatch({
            type: "APPEND_USER",
            cwd,
            sid,
            msg: { id: "older", kind: "user", text: olderText, ts: 1 },
        });
        assert.equal(getSessionState(state[cwd], sid)?.truncated, true);

        const role = source === "user" || source === "optimistic" ? "user" : "assistant";
        const message = {
            role,
            content: outcome === "error" ? [] : [{ type: "text", text: "Complete message" }],
            timestamp: messageTimestamp,
            ...(outcome === "complete"
                ? {}
                : { stopReason: "error", errorMessage: "Request failed" }),
        };
        if (source === "optimistic") {
            dispatch({
                type: "APPEND_USER",
                cwd,
                sid,
                msg: {
                    id: "optimistic-user-pending",
                    kind: "user",
                    text: "Complete message",
                    ts: receivedAt - 1,
                },
            });
        }
        if (source === "stream") {
            dispatch({
                type: "APPLY_EVENT",
                cwd,
                sid,
                now: messageTimestamp + 10,
                suppressedThinking: false,
                ev: {
                    type: "message_start",
                    message: { role: "assistant", timestamp: messageTimestamp },
                },
            });
        }
        if (source === "final") {
            dispatch({ type: "APPEND_ASSISTANT_FINAL", cwd, sid, reply: message as AgentMessage });
        } else {
            dispatch({
                type: "APPLY_EVENT",
                cwd,
                sid,
                now: receivedAt,
                suppressedThinking: false,
                ev: { type: "message_end", message },
            });
        }
        const entries: HistoryEntryLike[] = [
            {
                id: "older",
                type: "message",
                timestamp: 1,
                payload: { role: "user", content: olderText, timestamp: 1 },
            },
            {
                id: "persisted-message",
                type: "message",
                timestamp: new Date(persistedAt).toISOString(),
                payload: message,
            },
        ];
        const messages = historyToUiMessages(entries);
        for (let attempt = 0; attempt < 2; attempt++) {
            dispatch({ type: "ATTACH_START", cwd, sid });
            dispatch({
                type: "ATTACH",
                cwd,
                sid,
                messages,
                makeActive: true,
                execution: "idle",
                inFlightAgentToolCallIds: [],
            });
            const session = getSessionState(state[cwd], sid);
            assert.ok(session);
            assert.equal(session.sync, "current");
            assert.equal(session.truncated, true);
            assert.ok(session.cacheBytes <= SESSION_CACHE_ACTIVE_BYTE_BUDGET);
            const expected = messages.filter((m) => m.id !== "older");
            assert.deepEqual(
                session.messages.map((m) => ({ kind: m.kind, text: m.text, ts: m.ts })),
                expected.map((m) => ({ kind: m.kind, text: m.text, ts: m.ts })),
            );
            assert.ok(session.messages.every((m) => m.ts === messageTimestamp));
        }
    });
}

test("history falls back to entry timestamps for absent or invalid message timestamps", () => {
    for (const timestamp of [undefined, "invalid", Number.NaN]) {
        const messages = historyToUiMessages([
            {
                id: "persisted",
                type: "message",
                timestamp: new Date(persistedAt).toISOString(),
                payload: {
                    role: "assistant",
                    content: [{ type: "text", text: "reply" }],
                    timestamp,
                },
            },
        ]);
        assert.equal(messages[0]?.ts, persistedAt);
    }
});
