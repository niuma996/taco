/**
 * workspaceReducer tests — pure functions, no need to mock localStorage / React.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:reducer
 *
 * Covers core invariants for every action: no input mutation, reverse sort by
 * createdAt, activeSession semantics, pending clearing, and the
 * APPEND_ASSISTANT_FINAL live-bubble-overwrite / error-append branches.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { SessionEventLike, UiMessage } from "../../src/lib/chatUtils";
import {
    sortSessionsByUpdatedDesc,
    type WorkspaceState,
    workspacesReducer,
} from "../../src/lib/workspaceReducer";

function baseWs(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
    return {
        cwd: "/ws",
        active: true,
        sessions: [],
        messages: [],
        subagentSpawned: {},
        childMessagesBySubSessionId: {},
        childHistoryLoaded: {},
        askUserPending: {},
        agentToolPending: {},
        pendingBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
        forceExpandTaskPanelByCwd: {},
        ...overrides,
    };
}

describe("sidecar restart", () => {
    it("marks running shell tools as failed without changing completed tools", () => {
        const messages: UiMessage[] = [
            {
                id: "assistant-1",
                kind: "assistant",
                text: "",
                ts: 1,
                thinking: [],
                tools: [
                    {
                        id: "running-shell",
                        name: "shell",
                        args: { command: "git log" },
                        status: "running",
                    },
                    {
                        id: "done-shell",
                        name: "shell",
                        args: { command: "pwd" },
                        status: "ok",
                    },
                    {
                        id: "running-other",
                        name: "grep",
                        args: { pattern: "x" },
                        status: "running",
                    },
                ],
            },
        ];
        const state = { "/ws": baseWs({ activeSession: "s1", messages }) };

        const next = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/ws" });
        const tools = next["/ws"]?.messages[0];
        assert.equal(tools?.kind, "assistant");
        if (tools?.kind !== "assistant") return;
        assert.equal(tools.tools[0]?.status, "error");
        assert.deepEqual(tools.tools[0]?.details, {
            reason: "sidecar_restarted",
            exitCode: -1,
            interrupted: false,
        });
        assert.equal(tools.tools[1]?.status, "ok");
        assert.equal(tools.tools[2]?.status, "running");
        assert.equal(state["/ws"]?.messages[0]?.kind, "assistant");
    });

    it("also marks running shells in subagent streams as failed", () => {
        const childMessages: UiMessage[] = [
            {
                id: "child-assistant-1",
                kind: "assistant",
                text: "",
                ts: 1,
                thinking: [],
                tools: [
                    {
                        id: "child-running-shell",
                        name: "shell",
                        args: { command: "make" },
                        status: "running",
                    },
                ],
            },
        ];
        const state = {
            "/ws": baseWs({
                activeSession: "s1",
                messages: [],
                childMessagesBySubSessionId: { "sub-1": childMessages },
            }),
        };

        const next = workspacesReducer(state, { type: "SIDECAR_RESTARTED", cwd: "/ws" });
        const updatedChild = next["/ws"]?.childMessagesBySubSessionId["sub-1"]?.[0];
        assert.equal(updatedChild?.kind, "assistant");
        if (updatedChild?.kind !== "assistant") return;
        assert.equal(updatedChild.tools[0]?.status, "error");
        assert.deepEqual(updatedChild.tools[0]?.details, {
            reason: "sidecar_restarted",
            exitCode: -1,
            interrupted: false,
        });
        // Original child stream untouched (no mutation).
        assert.equal(state["/ws"]?.childMessagesBySubSessionId["sub-1"]?.[0]?.kind, "assistant");
    });
});

describe("sortSessionsByUpdatedDesc", () => {
    it("sorts most-recently-active first without mutating input", () => {
        const input = [
            { id: "a", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z" },
            { id: "b", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-10T00:00:00Z" },
            { id: "c", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-04-01T00:00:00Z" },
        ];
        const out = sortSessionsByUpdatedDesc(input);
        assert.deepEqual(
            out.map((s) => s.id),
            ["c", "b", "a"],
        );
        // Original array is not mutated
        assert.deepEqual(
            input.map((s) => s.id),
            ["a", "b", "c"],
        );
    });

    it("falls back to createdAt when updatedAt is missing", () => {
        const input = [
            { id: "a", createdAt: "2026-01-01T00:00:00Z" }, // no updatedAt
            { id: "b", createdAt: "2026-03-01T00:00:00Z" },
            { id: "c", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-05T00:00:00Z" },
        ];
        const out = sortSessionsByUpdatedDesc(input);
        // a has no updatedAt → falls back to createdAt (oldest), ranks last.
        // b has no updatedAt either, but its createdAt is newer; after fallback it still outranks c's updatedAt.
        assert.deepEqual(
            out.map((s) => s.id),
            ["b", "c", "a"],
        );
    });

    it("mixed updatedAt/createdAt compares each by updatedAt ?? createdAt", () => {
        const input = [
            { id: "old-upd", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" },
            { id: "no-upd", createdAt: "2026-05-01T00:00:00Z" },
        ];
        const out = sortSessionsByUpdatedDesc(input);
        assert.deepEqual(
            out.map((s) => s.id),
            ["old-upd", "no-upd"],
        );
    });

    it("equal timestamps keep insertion order (stable sort)", () => {
        const input = [
            { id: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
            { id: "y", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        ];
        const out = sortSessionsByUpdatedDesc(input);
        assert.deepEqual(
            out.map((s) => s.id),
            ["x", "y"],
        );
    });
});

describe("workspacesReducer — INIT / SET_ACTIVE", () => {
    it("INIT replaces the whole state", () => {
        const next = workspacesReducer({}, { type: "INIT", workspaces: { "/ws": baseWs() } });
        assert.ok(next["/ws"]);
    });

    it("SET_ACTIVE flips active flag by cwd", () => {
        const state = {
            "/a": baseWs({ cwd: "/a", active: true }),
            "/b": baseWs({ cwd: "/b", active: false }),
        };
        const next = workspacesReducer(state, { type: "SET_ACTIVE", cwd: "/b" });
        assert.equal(next["/a"]?.active, false);
        assert.equal(next["/b"]?.active, true);
        // Does not mutate the original state
        assert.equal(state["/a"]?.active, true);
    });
});

describe("workspacesReducer — sessions", () => {
    it("LOAD_SESSIONS creates workspace if missing and sorts desc", () => {
        const next = workspacesReducer(
            {},
            {
                type: "LOAD_SESSIONS",
                cwd: "/ws",
                sessions: [
                    { id: "old", createdAt: "2026-01-01T00:00:00Z" },
                    { id: "new", createdAt: "2026-05-01T00:00:00Z" },
                ],
            },
        );
        assert.deepEqual(
            next["/ws"]?.sessions.map((s) => s.id),
            ["new", "old"],
        );
    });

    it("LOAD_SESSIONS stores cursor + total for the paginated sidebar", () => {
        const next = workspacesReducer(
            {},
            {
                type: "LOAD_SESSIONS",
                cwd: "/ws",
                sessions: [{ id: "a", createdAt: "2026-01-01T00:00:00Z" }],
                nextCursor: { updatedAt: "2026-01-01T00:00:00Z", id: "a" },
                total: 42,
            },
        );
        assert.deepEqual(next["/ws"]?.listCursor, {
            updatedAt: "2026-01-01T00:00:00Z",
            id: "a",
        });
        assert.equal(next["/ws"]?.listTotal, 42);
    });

    it("LOAD_SESSIONS without append replaces the list and clears a spent cursor", () => {
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "page1", createdAt: "2026-01-01T00:00:00Z" },
                    { id: "page2", createdAt: "2026-01-02T00:00:00Z" },
                ],
                listCursor: { updatedAt: "2026-01-01T00:00:00Z", id: "page1" },
                listTotal: 2,
            }),
        };
        const next = workspacesReducer(state, {
            type: "LOAD_SESSIONS",
            cwd: "/ws",
            sessions: [{ id: "fresh", createdAt: "2026-06-01T00:00:00Z" }],
            total: 1,
        });
        assert.deepEqual(
            next["/ws"]?.sessions.map((s) => s.id),
            ["fresh"],
        );
        assert.equal(next["/ws"]?.listCursor, undefined);
        assert.equal(next["/ws"]?.listTotal, 1);
    });

    it("LOAD_SESSIONS with append merges the next page and re-sorts", () => {
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "b", createdAt: "2026-05-01T00:00:00Z" },
                    { id: "d", createdAt: "2026-03-01T00:00:00Z" },
                ],
                listCursor: { updatedAt: "2026-03-01T00:00:00Z", id: "d" },
                listTotal: 4,
            }),
        };
        const next = workspacesReducer(state, {
            type: "LOAD_SESSIONS",
            cwd: "/ws",
            sessions: [
                { id: "a", createdAt: "2026-06-01T00:00:00Z" },
                { id: "c", createdAt: "2026-04-01T00:00:00Z" },
            ],
            append: true,
            total: 4,
        });
        // Appended rows are merged into the existing list, then sorted desc.
        assert.deepEqual(
            next["/ws"]?.sessions.map((s) => s.id),
            ["a", "b", "c", "d"],
        );
        assert.equal(next["/ws"]?.listTotal, 4);
    });

    it("REMOVE_SESSION decrements listTotal and clears a cursor pointing at it", () => {
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "keep", createdAt: "2026-01-02T00:00:00Z" },
                    { id: "drop", createdAt: "2026-01-01T00:00:00Z" },
                ],
                listCursor: { updatedAt: "2026-01-01T00:00:00Z", id: "drop" },
                listTotal: 9,
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.deepEqual(
            next["/ws"]?.sessions.map((s) => s.id),
            ["keep"],
        );
        assert.equal(next["/ws"]?.listCursor, undefined, "stale cursor must not survive");
        assert.equal(next["/ws"]?.listTotal, 8);
    });

    it("REMOVE_SESSION keeps a cursor that points at a different session", () => {
        const cursor = { updatedAt: "2026-01-02T00:00:00Z", id: "keep" };
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "keep", createdAt: "2026-01-02T00:00:00Z" },
                    { id: "drop", createdAt: "2026-01-01T00:00:00Z" },
                ],
                listCursor: cursor,
                listTotal: 2,
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.deepEqual(next["/ws"]?.listCursor, cursor);
        assert.equal(next["/ws"]?.listTotal, 1);
    });

    it("REMOVE_SESSION leaves listTotal unset when it was never known", () => {
        const state = {
            "/ws": baseWs({
                sessions: [{ id: "drop", createdAt: "2026-01-01T00:00:00Z" }],
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.equal(next["/ws"]?.listTotal, undefined);
    });

    it("ADD_SESSION with makeActive:false keeps existing activeSession", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "keep",
                sessions: [{ id: "keep", createdAt: "2026-01-01T00:00:00Z" }],
            }),
        };
        const next = workspacesReducer(state, {
            type: "ADD_SESSION",
            cwd: "/ws",
            session: { id: "added", createdAt: "2026-02-01T00:00:00Z" },
            makeActive: false,
        });
        assert.equal(next["/ws"]?.activeSession, "keep");
        assert.equal(next["/ws"]?.sessions.length, 2);
    });

    it("ADD_SESSION defaults to making the new session active", () => {
        const state = { "/ws": baseWs() };
        const next = workspacesReducer(state, {
            type: "ADD_SESSION",
            cwd: "/ws",
            session: { id: "added", createdAt: "2026-02-01T00:00:00Z" },
        });
        assert.equal(next["/ws"]?.activeSession, "added");
    });

    it("BUMP_SESSION_TIME moves the target session to top without mutating input", () => {
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "a", createdAt: "2026-01-01T00:00:00Z" },
                    { id: "b", createdAt: "2026-03-01T00:00:00Z" },
                ],
            }),
        };
        const next = workspacesReducer(state, {
            type: "BUMP_SESSION_TIME",
            cwd: "/ws",
            sid: "a",
            updatedAt: "2026-06-01T00:00:00Z",
        });
        assert.deepEqual(
            next["/ws"]?.sessions.map((s) => s.id),
            ["a", "b"],
        );
        // Original state is not mutated
        assert.deepEqual(
            state["/ws"]?.sessions.map((s) => s.id),
            ["a", "b"],
        );
    });

    it("BUMP_SESSION_TIME ignores unknown sid", () => {
        const state = {
            "/ws": baseWs({
                sessions: [{ id: "a", createdAt: "2026-01-01T00:00:00Z" }],
            }),
        };
        const next = workspacesReducer(state, {
            type: "BUMP_SESSION_TIME",
            cwd: "/ws",
            sid: "missing",
            updatedAt: "2026-06-01T00:00:00Z",
        });
        assert.equal(next, state);
    });

    it("REMOVE_SESSION clears messages+activeSession when removing the active one", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "x",
                sessions: [{ id: "x", createdAt: "2026-01-01T00:00:00Z" }],
                messages: [{ id: "m1", kind: "user", text: "hi", ts: 1 } as UiMessage],
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "x" });
        assert.equal(next["/ws"]?.activeSession, undefined);
        assert.deepEqual(next["/ws"]?.messages, []);
        assert.deepEqual(next["/ws"]?.sessions, []);
    });

    it("REMOVE_SESSION keeps activeSession when removing a non-active one", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "keep",
                sessions: [
                    { id: "keep", createdAt: "2026-02-01T00:00:00Z" },
                    { id: "drop", createdAt: "2026-01-01T00:00:00Z" },
                ],
                messages: [{ id: "m1", kind: "user", text: "hi", ts: 1 } as UiMessage],
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.equal(next["/ws"]?.activeSession, "keep");
        assert.equal(next["/ws"]?.messages.length, 1);
    });

    it("REMOVE_SESSION drops the removed sid's pending slot but keeps others", () => {
        const state = {
            "/ws": baseWs({
                sessions: [
                    { id: "drop", createdAt: "2026-01-01T00:00:00Z" },
                    { id: "keep", createdAt: "2026-01-01T00:00:00Z" },
                ],
                pendingBySessionId: { drop: true, keep: true },
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.equal(next["/ws"]?.pendingBySessionId.drop, undefined);
        assert.equal(next["/ws"]?.pendingBySessionId.keep, true);
    });

    it("REMOVE_SESSION preserves the pending map when the sid has no pending slot", () => {
        const state = {
            "/ws": baseWs({
                sessions: [{ id: "drop", createdAt: "2026-01-01T00:00:00Z" }],
                pendingBySessionId: { other: true },
            }),
        };
        const next = workspacesReducer(state, { type: "REMOVE_SESSION", cwd: "/ws", sid: "drop" });
        assert.deepEqual(next["/ws"]?.pendingBySessionId, { other: true });
    });
});

describe("workspacesReducer — guards", () => {
    it("returns state unchanged for unknown cwd", () => {
        const state = { "/ws": baseWs() };
        const next = workspacesReducer(state, {
            type: "SET_PENDING",
            cwd: "/other",
            sid: "s1",
            pending: true,
        });
        assert.equal(next, state);
    });

    it("APPEND_SYSTEM ignored when sid mismatches activeSession", () => {
        const state = { "/ws": baseWs({ activeSession: "a" }) };
        const next = workspacesReducer(state, {
            type: "APPEND_SYSTEM",
            cwd: "/ws",
            sid: "b",
            msg: { id: "s", kind: "system", text: "x", ts: 1 } as UiMessage,
        });
        assert.equal(next, state);
    });

    it("APPLY_EVENT ignored when sid mismatches activeSession (background session stream)", () => {
        // Regression: stream events from background session a must not bleed into
        // the shared messages of the actively displayed session b.
        const state = {
            "/ws": baseWs({
                activeSession: "b",
                messages: [{ id: "m1", kind: "user", text: "b-msg", ts: 1 } as UiMessage],
            }),
        };
        const next = workspacesReducer(state, {
            type: "APPLY_EVENT",
            cwd: "/ws",
            sid: "a",
            suppressedThinking: false,
            now: 2,
            ev: { type: "message_start", message: { role: "assistant", timestamp: 2 } },
        });
        assert.equal(next, state);
        assert.equal(next["/ws"]?.messages.length, 1);
    });

    it("APPLY_EVENT applies when sid matches activeSession", () => {
        const state = { "/ws": baseWs({ activeSession: "a" }) };
        const next = workspacesReducer(state, {
            type: "APPLY_EVENT",
            cwd: "/ws",
            sid: "a",
            suppressedThinking: false,
            now: 2,
            ev: { type: "message_start", message: { role: "assistant", timestamp: 2 } },
        });
        assert.equal(next["/ws"]?.messages.length, 1);
    });
});

describe("workspacesReducer — APPEND_ASSISTANT_FINAL", () => {
    // Guards the reason sendPrompt must dispatch SET_PENDING(false) explicitly
    // on both branches: once the user has moved on to another session, this
    // action is dropped whole and can no longer clear the turn's pending slot.
    it("drops the action for a non-active sid, leaving its pending slot untouched", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "s2",
                pendingBySessionId: { s1: true },
            }),
        };
        const next = workspacesReducer(state, {
            type: "APPEND_ASSISTANT_FINAL",
            cwd: "/ws",
            sid: "s1",
            reply: { role: "assistant", content: [], timestamp: 1 } as never,
        });
        assert.equal(next, state);
        assert.equal(next["/ws"]?.pendingBySessionId.s1, true);
    });

    it("appends a new assistant bubble + error system message on stopReason=error", () => {
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        const next = workspacesReducer(state, {
            type: "APPEND_ASSISTANT_FINAL",
            cwd: "/ws",
            sid: "s1",
            reply: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "API key missing",
                timestamp: 12345,
            } as never,
        });
        const msgs = next["/ws"]?.messages ?? [];
        assert.equal(msgs.length, 2);
        assert.equal(msgs[0]?.kind, "assistant");
        assert.equal(msgs[1]?.kind, "system");
        assert.match((msgs[1] as Extract<UiMessage, { kind: "system" }>).text, /API key missing/);
        assert.equal(next["/ws"]?.pendingBySessionId.s1, false);
    });

    it("overwrites the pre-created live bubble instead of appending", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "s1",
                messages: [
                    {
                        id: "live-asst-999",
                        kind: "assistant",
                        text: "",
                        ts: 1,
                        tools: [],
                        thinking: [],
                    } as UiMessage,
                ],
            }),
        };
        const next = workspacesReducer(state, {
            type: "APPEND_ASSISTANT_FINAL",
            cwd: "/ws",
            sid: "s1",
            reply: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                timestamp: 999,
            } as never,
        });
        const msgs = next["/ws"]?.messages ?? [];
        assert.equal(msgs.length, 1);
        assert.equal((msgs[0] as Extract<UiMessage, { kind: "assistant" }>).text, "done");
        // Input state must not be mutated: the original bubble text must still be empty.
        // Shallow-copying the array is not enough; must shallow-copy the bubble too and overwrite it,
        // otherwise the input is contaminated (reducer is impure; StrictMode's double-call
        // and future same-kind bugs would both be caught by this assertion).
        assert.equal(
            (state["/ws"]?.messages[0] as Extract<UiMessage, { kind: "assistant" }>).text,
            "",
        );
    });
});

describe("subagent actions", () => {
    // agentToolPending gates the send/stop button. Only an `agent` tool ending
    // without error resolves via the subagentSpawned reverse-lookup; an errored
    // agent and a skill-spawned subagent never match it, so both must clear
    // their entry directly or the input box stays disabled forever.
    function toolEndEvent(toolCallId: string, toolName: string, isError: boolean) {
        return {
            type: "APPLY_EVENT" as const,
            cwd: "/ws",
            sid: "main-1",
            suppressedThinking: false,
            now: 3,
            ev: { type: "tool_execution_end" as const, toolCallId, toolName, isError },
        };
    }

    it("clears agentToolPending when an agent tool ends with an error", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                agentToolPending: { "tc-1": true },
                subagentSpawned: {
                    "main-1:tc-1": {
                        subSessionId: "sub-1",
                        agentType: "explorer",
                        parentToolCallId: "tc-1",
                    },
                },
            }),
        };
        const next = workspacesReducer(state, toolEndEvent("tc-1", "agent", true));
        assert.deepEqual(next["/ws"]?.agentToolPending, {});
    });

    it("clears agentToolPending when a skill-spawned subagent ends", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                agentToolPending: { "tc-2": true },
                // skill subagents emit subagent.spawned with the skill tool's
                // toolCallId, so the toolName on end is "skill", not "agent".
                subagentSpawned: {
                    "main-1:tc-2": {
                        subSessionId: "sub-2",
                        agentType: "researcher",
                        parentToolCallId: "tc-2",
                    },
                },
            }),
        };
        const next = workspacesReducer(state, toolEndEvent("tc-2", "skill", false));
        assert.deepEqual(next["/ws"]?.agentToolPending, {});
    });

    it("SUBAGENT_SPAWNED adds entry keyed by parentSessionId+parentToolCallId", () => {
        const state = { "/ws": baseWs({ activeSession: "main-1" }) };
        const next = workspacesReducer(state, {
            type: "SUBAGENT_SPAWNED",
            cwd: "/ws",
            parentSessionId: "main-1",
            parentToolCallId: "tc-1",
            subSessionId: "sub-1",
            agentType: "explorer",
        });
        assert.deepEqual(next["/ws"]?.subagentSpawned["main-1:tc-1"], {
            subSessionId: "sub-1",
            agentType: "explorer",
            parentToolCallId: "tc-1",
        });
        // Must not mutate input
        assert.deepEqual(state["/ws"]?.subagentSpawned, {});
    });

    it("SUBAGENT_SPAWNED backfills details.subSessionId on the matching agent tool", () => {
        // Without this backfill the agent card has no subSessionId until
        // tool_execution_end, so it renders "spawning…" for the whole run even
        // though the child stream is already accumulating.
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                messages: [
                    {
                        id: "assistant-1",
                        kind: "assistant",
                        text: "",
                        ts: 1,
                        thinking: [],
                        tools: [
                            { id: "other-tc", name: "shell", args: {}, status: "running" },
                            { id: "tc-1", name: "agent", args: {}, status: "running" },
                        ],
                    },
                ] as UiMessage[],
            }),
        };
        const next = workspacesReducer(state, {
            type: "SUBAGENT_SPAWNED",
            cwd: "/ws",
            parentSessionId: "main-1",
            parentToolCallId: "tc-1",
            subSessionId: "sub-1",
            agentType: "explorer",
        });
        const tools = (next["/ws"]?.messages[0] as Extract<UiMessage, { kind: "assistant" }>).tools;
        assert.deepEqual(tools[1]?.details, {
            subSessionId: "sub-1",
            agentType: "explorer",
        });
        // Sibling tools and the input state are untouched.
        assert.equal(tools[0]?.details, undefined);
        const prevTools = (state["/ws"]?.messages[0] as Extract<UiMessage, { kind: "assistant" }>)
            .tools;
        assert.equal(prevTools[1]?.details, undefined);
    });

    it("SUBAGENT_SPAWNED updates existing entry if same key", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                subagentSpawned: {
                    "main-1:tc-1": {
                        subSessionId: "old",
                        agentType: "explorer",
                        parentToolCallId: "tc-1",
                    },
                },
            }),
        };
        const next = workspacesReducer(state, {
            type: "SUBAGENT_SPAWNED",
            cwd: "/ws",
            parentSessionId: "main-1",
            parentToolCallId: "tc-1",
            subSessionId: "new",
            agentType: "planner",
        });
        assert.deepEqual(next["/ws"]?.subagentSpawned["main-1:tc-1"], {
            subSessionId: "new",
            agentType: "planner",
            parentToolCallId: "tc-1",
        });
        assert.equal(Object.keys(next["/ws"]?.subagentSpawned ?? {}).length, 1);
    });

    it("CHILD_MESSAGE_EVENT appends to childMessagesBySubSessionId", () => {
        const state = {
            "/ws": baseWs({
                childMessagesBySubSessionId: {
                    "sub-1": [
                        {
                            id: "live-asst-1",
                            kind: "assistant",
                            text: "",
                            ts: 1,
                            tools: [],
                            thinking: [],
                        } as UiMessage,
                    ],
                },
            }),
        };
        const next = workspacesReducer(state, {
            type: "CHILD_MESSAGE_EVENT",
            cwd: "/ws",
            subSessionId: "sub-1",
            suppressedThinking: false,
            now: 2,
            ev: { type: "message_start", message: { role: "assistant", timestamp: 2 } },
        });
        assert.equal(next["/ws"]?.childMessagesBySubSessionId["sub-1"]?.length, 2);
    });

    it("CHILD_MESSAGE_EVENT creates new subSession bucket if missing", () => {
        const state = { "/ws": baseWs() };
        const next = workspacesReducer(state, {
            type: "CHILD_MESSAGE_EVENT",
            cwd: "/ws",
            subSessionId: "sub-new",
            suppressedThinking: false,
            now: 5,
            ev: { type: "message_start", message: { role: "assistant", timestamp: 5 } },
        });
        assert.equal(next["/ws"]?.childMessagesBySubSessionId["sub-new"]?.length, 1);
    });

    it("LOAD_SUBAGENT_HISTORY sets childHistoryLoaded", () => {
        const state = { "/ws": baseWs() };
        const history = [{ id: "h1", kind: "user", text: "hi", ts: 1 } as UiMessage];
        const next = workspacesReducer(state, {
            type: "LOAD_SUBAGENT_HISTORY",
            cwd: "/ws",
            subSessionId: "sub-1",
            messages: history,
        });
        assert.deepEqual(next["/ws"]?.childHistoryLoaded["sub-1"], history);
    });

    it("RESTORE_SESSION_SNAPSHOT updates the active main session without switching views", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                messages: [{ id: "stale", kind: "user", text: "old", ts: 1 } as UiMessage],
                askUserPending: { "old-tool": true },
            }),
        };
        const messages = [{ id: "fresh", kind: "assistant", text: "new", ts: 2 } as UiMessage];

        const next = workspacesReducer(state, {
            type: "RESTORE_SESSION_SNAPSHOT",
            cwd: "/ws",
            sid: "main-1",
            sessionKind: "main",
            messages,
            pendingAskUserIds: ["fresh-tool"],
        });

        assert.equal(next["/ws"]?.activeSession, "main-1");
        assert.deepEqual(next["/ws"]?.messages, messages);
        assert.deepEqual(next["/ws"]?.askUserPending, { "fresh-tool": true });
    });

    it("RESTORE_SESSION_SNAPSHOT replaces a subagent stream without changing the main view", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                childMessagesBySubSessionId: {
                    "sub-1": [
                        { id: "partial", kind: "assistant", text: "partial", ts: 1 } as UiMessage,
                    ],
                },
            }),
        };
        const messages = [
            { id: "complete", kind: "assistant", text: "complete", ts: 2 } as UiMessage,
        ];

        const next = workspacesReducer(state, {
            type: "RESTORE_SESSION_SNAPSHOT",
            cwd: "/ws",
            sid: "sub-1",
            sessionKind: "subagent",
            messages,
        });

        assert.equal(next["/ws"]?.activeSession, "main-1");
        assert.deepEqual(next["/ws"]?.childMessagesBySubSessionId["sub-1"], messages);
        assert.deepEqual(next["/ws"]?.childHistoryLoaded["sub-1"], messages);
    });

    it("ATTACH preserves subagent state when same session", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                subagentSpawned: {
                    "main-1:tc-1": {
                        subSessionId: "sub-1",
                        agentType: "explorer",
                        parentToolCallId: "tc-1",
                    },
                },
                childMessagesBySubSessionId: {
                    "sub-1": [{ id: "m1", kind: "user", text: "x", ts: 1 } as UiMessage],
                },
            }),
        };
        const next = workspacesReducer(state, {
            type: "ATTACH",
            cwd: "/ws",
            sid: "main-1",
            messages: [{ id: "m2", kind: "user", text: "y", ts: 2 } as UiMessage],
        });
        // Same session re-attach: returns unchanged, live stream is not lost.
        assert.equal(next, state);
        assert.deepEqual(next["/ws"]?.subagentSpawned["main-1:tc-1"], {
            subSessionId: "sub-1",
            agentType: "explorer",
            parentToolCallId: "tc-1",
        });
        assert.equal(next["/ws"]?.childMessagesBySubSessionId["sub-1"]?.length, 1);
    });

    it("ATTACH clears subagent state when switching session", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "main-1",
                subagentSpawned: {
                    "main-1:tc-1": {
                        subSessionId: "sub-1",
                        agentType: "explorer",
                        parentToolCallId: "tc-1",
                    },
                },
                childMessagesBySubSessionId: {
                    "sub-1": [{ id: "m1", kind: "user", text: "x", ts: 1 } as UiMessage],
                },
                childHistoryLoaded: { "sub-1": [] },
            }),
        };
        const next = workspacesReducer(state, {
            type: "ATTACH",
            cwd: "/ws",
            sid: "main-2",
            messages: [],
        });
        assert.equal(next["/ws"]?.activeSession, "main-2");
        assert.deepEqual(next["/ws"]?.subagentSpawned, {});
        assert.deepEqual(next["/ws"]?.childMessagesBySubSessionId, {});
        assert.deepEqual(next["/ws"]?.childHistoryLoaded, {});
    });
});

describe("workspacesReducer — askUser pending lifecycle", () => {
    // askUser tool: waiting=true → askUserPending[toolCallId]=true;
    // waiting=false (user has answered) → askUserPending deletes that key;
    // Under no circumstances may the reducer mutate the action.ev input (the previous
    // `action.ev.result.details = ...` was a bug).
    function askUserEvent(toolCallId: string, waiting: boolean, questions?: unknown) {
        return {
            type: "APPLY_EVENT" as const,
            cwd: "/ws",
            sid: "s1",
            suppressedThinking: false,
            now: 1,
            ev: {
                type: "tool_execution_end",
                toolName: "askUser",
                toolCallId,
                isError: false,
                result: { details: { waiting, questions } },
            } satisfies SessionEventLike,
        };
    }

    it("waiting=true writes askUserPending[toolCallId] = true", () => {
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        const next = workspacesReducer(state, askUserEvent("tc-1", true));
        assert.equal(next["/ws"]?.askUserPending["tc-1"], true);
    });

    it("waiting=false on a tracked toolCallId removes the pending entry", () => {
        const state = {
            "/ws": baseWs({ activeSession: "s1", askUserPending: { "tc-1": true } }),
        };
        const next = workspacesReducer(state, askUserEvent("tc-1", false));
        assert.deepEqual(next["/ws"]?.askUserPending, {});
    });

    it("does not mutate the action.ev object across APPLY_EVENT", () => {
        // Key invariant: previously the reducer assigned `action.ev.result.details = {...}`
        // directly in the waiting !== true branch, contaminating the input —
        // StrictMode's double-call / time-travel debugging would break.
        const ev: SessionEventLike = {
            type: "tool_execution_end",
            toolName: "askUser",
            toolCallId: "tc-1",
            isError: false,
            result: { details: { waiting: true, questions: [{ question: "q" }] } },
        };
        const action = {
            type: "APPLY_EVENT" as const,
            cwd: "/ws",
            sid: "s1",
            suppressedThinking: false,
            now: 1,
            ev,
        };
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        workspacesReducer(state, action);
        // Input ev.result.details must not be rewritten (SessionEventLike makes result
        // optional + details: unknown; here it is narrowed and asserted)
        const details = ev.result?.details as {
            waiting?: boolean;
            questions?: { question: string }[];
        };
        assert.equal(details.waiting, true);
        assert.deepEqual(details.questions, [{ question: "q" }]);
    });

    it("ASKUSER_ANSWERED with cwd removes pending for that toolCallId", () => {
        const state = {
            "/ws": baseWs({ activeSession: "s1", askUserPending: { "tc-1": true } }),
        };
        const next = workspacesReducer(state, {
            type: "ASKUSER_ANSWERED",
            cwd: "/ws",
            toolCallId: "tc-1",
            answers: { q1: "opt-a" },
        });
        assert.deepEqual(next["/ws"]?.askUserPending, {});
    });

    it("ASKUSER_ANSWERED without cwd locates the workspace by toolCallId", () => {
        const state = {
            "/a": baseWs({ cwd: "/a", activeSession: "s1", askUserPending: { "tc-1": true } }),
            "/b": baseWs({ cwd: "/b", activeSession: "s2" }),
        };
        const next = workspacesReducer(state, {
            type: "ASKUSER_ANSWERED",
            toolCallId: "tc-1",
            answers: { q1: "opt-a" },
        });
        assert.deepEqual(next["/a"]?.askUserPending, {});
        assert.deepEqual(next["/b"]?.askUserPending, {});
    });

    it("ASKUSER_ANSWERED on unknown toolCallId leaves state unchanged", () => {
        const state = {
            "/ws": baseWs({ activeSession: "s1", askUserPending: { "tc-1": true } }),
        };
        const next = workspacesReducer(state, {
            type: "ASKUSER_ANSWERED",
            cwd: "/ws",
            toolCallId: "tc-doesnt-exist",
            answers: {},
        });
        assert.deepEqual(next["/ws"]?.askUserPending, { "tc-1": true });
    });
});

describe("workspacesReducer — per-session task snapshots", () => {
    it("TASKS_UPDATED writes into the session's own slot, isolated per sid", () => {
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        const active = {
            id: "l1",
            name: "A",
            tasks: [{ id: "t1", content: "x", status: "pending" as const, activeForm: "x" }],
        };
        const next = workspacesReducer(state, {
            type: "TASKS_UPDATED",
            cwd: "/ws",
            sid: "s1",
            active,
            history: [],
        });
        assert.equal(next["/ws"]?.taskSnapshotsBySessionId.s1?.active?.id, "l1");
        // other session untouched
        assert.equal(next["/ws"]?.taskSnapshotsBySessionId.s2, undefined);
    });

    it("two sessions keep independent snapshots", () => {
        let state: Record<string, WorkspaceState> = { "/ws": baseWs({ activeSession: "s1" }) };
        state = workspacesReducer(state, {
            type: "TASKS_UPDATED",
            cwd: "/ws",
            sid: "s1",
            active: { id: "l1", name: "A", tasks: [] },
            history: [],
        });
        state = workspacesReducer(state, {
            type: "TASKS_UPDATED",
            cwd: "/ws",
            sid: "s2",
            active: { id: "l2", name: "B", tasks: [] },
            history: [],
        });
        assert.equal(state["/ws"]?.taskSnapshotsBySessionId.s1?.active?.id, "l1");
        assert.equal(state["/ws"]?.taskSnapshotsBySessionId.s2?.active?.id, "l2");
    });
});

describe("workspacesReducer — plan state", () => {
    it("PLAN_STATE_UPDATED writes per-session plan state", () => {
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        const next = workspacesReducer(state, {
            type: "PLAN_STATE_UPDATED",
            cwd: "/ws",
            sid: "s1",
            active: true,
            currentSlug: "slug-1",
        });
        assert.equal(next["/ws"]?.planStatesBySessionId.s1?.active, true);
        assert.equal(next["/ws"]?.planStatesBySessionId.s1?.currentSlug, "slug-1");
    });
});

describe("workspacesReducer — history detail (lazy-loaded on expand)", () => {
    it("HISTORY_DETAIL_LOADED writes per-session AND per-listId slot", () => {
        const state: Record<string, WorkspaceState> = { "/ws": baseWs({ activeSession: "s1" }) };
        const tasks = [
            { id: "t1", content: "x", status: "completed" as const, activeForm: "x" },
            { id: "t2", content: "y", status: "failed" as const, activeForm: "y" },
        ];
        const next = workspacesReducer(state, {
            type: "HISTORY_DETAIL_LOADED",
            cwd: "/ws",
            sid: "s1",
            listId: "L-1",
            tasks,
        });
        const slot = next["/ws"]?.historyDetailsBySessionId.s1?.["L-1"];
        assert.equal(slot?.tasks.length, 2);
        assert.equal(slot?.tasks[0]?.status, "completed");
        assert.equal(slot?.tasks[1]?.status, "failed");
        // Other listId / other sessions are untouched
        assert.equal(next["/ws"]?.historyDetailsBySessionId.s1?.["L-2"], undefined);
        assert.equal(next["/ws"]?.historyDetailsBySessionId.s2, undefined);
    });

    it("多个 listId 在同一 session 下并存,互不覆盖", () => {
        const state: Record<string, WorkspaceState> = { "/ws": baseWs({ activeSession: "s1" }) };
        const a = [{ id: "ta", content: "A", status: "completed" as const, activeForm: "A" }];
        const b = [{ id: "tb", content: "B", status: "failed" as const, activeForm: "B" }];
        let next = workspacesReducer(state, {
            type: "HISTORY_DETAIL_LOADED",
            cwd: "/ws",
            sid: "s1",
            listId: "L-a",
            tasks: a,
        });
        next = workspacesReducer(next, {
            type: "HISTORY_DETAIL_LOADED",
            cwd: "/ws",
            sid: "s1",
            listId: "L-b",
            tasks: b,
        });
        assert.equal(next["/ws"]?.historyDetailsBySessionId.s1?.["L-a"]?.tasks[0]?.id, "ta");
        assert.equal(next["/ws"]?.historyDetailsBySessionId.s1?.["L-b"]?.tasks[0]?.id, "tb");
    });

    it("unknown cwd 时 action 是 no-op,不抛错", () => {
        const next = workspacesReducer(
            {},
            { type: "HISTORY_DETAIL_LOADED", cwd: "/other", sid: "s1", listId: "L", tasks: [] },
        );
        assert.deepEqual(next, {});
    });
});

describe("workspacesReducer — task panel force-expand on first snapshot", () => {
    it("TASK_PANEL_FORCE_EXPAND 写入 cwd 标记", () => {
        const state: Record<string, WorkspaceState> = { "/ws": baseWs() };
        const next = workspacesReducer(state, {
            type: "TASK_PANEL_FORCE_EXPAND",
            cwd: "/ws",
        });
        assert.equal(next["/ws"]?.forceExpandTaskPanelByCwd["/ws"], true);
    });

    it("CONSUMED 清除该 cwd 标记,其他 cwd 不动", () => {
        const state: Record<string, WorkspaceState> = {
            "/a": baseWs({ cwd: "/a" }),
            "/b": baseWs({ cwd: "/b" }),
        };
        // Both cwds pre-set to force-expand
        let next = workspacesReducer(state, { type: "TASK_PANEL_FORCE_EXPAND", cwd: "/a" });
        next = workspacesReducer(next, { type: "TASK_PANEL_FORCE_EXPAND", cwd: "/b" });
        assert.equal(next["/a"]?.forceExpandTaskPanelByCwd["/a"], true);
        assert.equal(next["/b"]?.forceExpandTaskPanelByCwd["/b"], true);

        next = workspacesReducer(next, {
            type: "TASK_PANEL_FORCE_EXPAND_CONSUMED",
            cwd: "/a",
        });
        assert.equal(next["/a"]?.forceExpandTaskPanelByCwd["/a"], undefined);
        // /b untouched
        assert.equal(next["/b"]?.forceExpandTaskPanelByCwd["/b"], true);
    });

    it("unknown cwd 时两个 action 都是 no-op", () => {
        const fe = workspacesReducer({}, { type: "TASK_PANEL_FORCE_EXPAND", cwd: "/x" });
        assert.deepEqual(fe, {});
        const c = workspacesReducer({}, { type: "TASK_PANEL_FORCE_EXPAND_CONSUMED", cwd: "/x" });
        assert.deepEqual(c, {});
    });
});

describe("workspacesReducer — per-session pending", () => {
    it("SET_PENDING writes into the session's own slot", () => {
        const state = { "/ws": baseWs({ activeSession: "s1" }) };
        const next = workspacesReducer(state, {
            type: "SET_PENDING",
            cwd: "/ws",
            sid: "s1",
            pending: true,
        });
        assert.equal(next["/ws"]?.pendingBySessionId.s1, true);
        assert.equal(next["/ws"]?.pendingBySessionId.s2, undefined);
    });

    it("two sessions keep independent pending state", () => {
        let state: Record<string, WorkspaceState> = { "/ws": baseWs({ activeSession: "s1" }) };
        state = workspacesReducer(state, {
            type: "SET_PENDING",
            cwd: "/ws",
            sid: "s1",
            pending: true,
        });
        state = workspacesReducer(state, {
            type: "SET_PENDING",
            cwd: "/ws",
            sid: "s2",
            pending: false,
        });
        assert.equal(state["/ws"]?.pendingBySessionId.s1, true);
        assert.equal(state["/ws"]?.pendingBySessionId.s2, false);
    });

    it("ATTACH to another session preserves the running session's slot", () => {
        const state = {
            "/ws": baseWs({ activeSession: "s1", pendingBySessionId: { s1: true } }),
        };
        const next = workspacesReducer(state, {
            type: "ATTACH",
            cwd: "/ws",
            sid: "s2",
            messages: [],
        });
        assert.equal(next["/ws"]?.activeSession, "s2");
        // Switching to an idle session: s2 has no running state → button shows "Send"
        assert.equal(next["/ws"]?.pendingBySessionId.s2, undefined);
        // Switching back can still restore "Stop"
        assert.equal(next["/ws"]?.pendingBySessionId.s1, true);
    });

    it("APPEND_SYSTEM clears pending only for its own sid", () => {
        const state = {
            "/ws": baseWs({
                activeSession: "s1",
                pendingBySessionId: { s1: true, s2: true },
            }),
        };
        const next = workspacesReducer(state, {
            type: "APPEND_SYSTEM",
            cwd: "/ws",
            sid: "s1",
            msg: { id: "sys", kind: "system", text: "x", ts: 1 } as UiMessage,
        });
        assert.equal(next["/ws"]?.pendingBySessionId.s1, false);
        assert.equal(next["/ws"]?.pendingBySessionId.s2, true);
    });

    it("SET_PENDING clears pending for background session by its own sid, without affecting active session", () => {
        // Simulate useWorkspaces dispatch sequence for background session completion:
        // 1. APPEND_ASSISTANT_FINAL on background session (guard returns early, no state change)
        // 2. SET_PENDING with captured promptSid clears background session's slot
        const state = {
            "/ws": baseWs({
                activeSession: "s2",
                pendingBySessionId: { s1: true, s2: false },
            }),
        };
        // Step 1: APPEND_ASSISTANT_FINAL on background session s1 — guard blocks state update,
        // messages and pendingBySessionId both unchanged
        const afterAppend = workspacesReducer(state, {
            type: "APPEND_ASSISTANT_FINAL",
            cwd: "/ws",
            sid: "s1",
            reply: {
                id: "r1",
                role: "assistant",
                content: [{ kind: "text", text: "done" }],
                stopReason: "end_turn",
                timestamp: 0,
            } as never,
        });
        // Guard on non-active session: pending unchanged
        assert.equal(afterAppend["/ws"]?.pendingBySessionId.s1, true);
        // active session untouched
        assert.equal(afterAppend["/ws"]?.pendingBySessionId.s2, false);

        // Step 2: SET_PENDING with captured promptSid clears background session's slot
        // (this is what useWorkspaces must dispatch in the non-empty reply branch)
        const afterClear = workspacesReducer(afterAppend, {
            type: "SET_PENDING",
            cwd: "/ws",
            sid: "s1",
            pending: false,
        });
        assert.equal(afterClear["/ws"]?.pendingBySessionId.s1, false);
        // active session s2 still unaffected
        assert.equal(afterClear["/ws"]?.pendingBySessionId.s2, false);
    });
});
