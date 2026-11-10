import type { SessionTarget } from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationActivity } from "../../src/hooks/useConversationActivity";
import {
    conversationActivityKey,
    getConversationActivity,
} from "../../src/lib/chat/conversationActivity";
import { createSessionState } from "../../src/lib/chat/sessionState";
import { createEmptyWorkspace, type WorkspaceState } from "../../src/lib/chat/workspaceReducer";

const target = { workspace: "/a", sessionId: "same" };
const key = conversationActivityKey(target);
function workspace(
    cwd = "/a",
    text = "",
    ts = 200,
): WorkspaceState & Required<Pick<WorkspaceState, "sessionStatesById">> {
    return {
        ...createEmptyWorkspace(cwd),
        activeSession: "same",
        sessions: [{ id: "same", createdAt: "2026-01-01" }],
        sessionStatesById: {
            same: {
                ...createSessionState(),
                revision: text ? 1 : 0,
                messages: text
                    ? [{ id: "reply", kind: "assistant", text, ts, tools: [], thinking: [] }]
                    : [],
            },
        },
    };
}
beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("conversation activity", () => {
    it("derives waiting for background askUser/planExit and child display approvals", () => {
        const ws = workspace();
        ws.sessionStatesById.same.askUserPending = { ask: true };
        expect(getConversationActivity(ws, "same").waiting).toBe(true);
        ws.sessionStatesById.same.askUserPending = {};
        ws.pendingCommandPermissions = {
            approval: { sessionId: "child", displaySessionId: "same" } as never,
        };
        expect(getConversationActivity(ws, "same").waiting).toBe(true);
        expect(getConversationActivity(ws, "other").waiting).toBe(false);
        ws.sessionStatesById.same.execution = "running";
        expect(getConversationActivity(ws, "same").running).toBe(true);
    });

    it("derives incomplete sync and clears a session error after newer transcript activity", () => {
        const ws = workspace();
        ws.sessionStatesById.same.sync = "incomplete";
        ws.sessionStatesById.same.messages = [
            {
                id: "error",
                kind: "system",
                text: "[session.error] provider failed",
                ts: 10,
            },
        ];
        expect(getConversationActivity(ws, "same")).toMatchObject({
            error: true,
            incomplete: true,
        });
        ws.sessionStatesById.same.messages.push({
            id: "recovered",
            kind: "assistant",
            text: "recovered",
            ts: 11,
            tools: [],
            thinking: [],
        });
        expect(getConversationActivity(ws, "same").error).toBe(false);
    });

    it("retains background unread through eviction and only acknowledges an explicit visible chat", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ ws, visible }) =>
                useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: visible }),
            {
                initialProps: { ws: workspace(), visible: null as SessionTarget | null },
            },
        );
        rerender({ ws: workspace("/a", "new reply"), visible: null });
        expect(result.current.unread[key]).toBe(true);
        rerender({ ws: { ...workspace(), sessionStatesById: {} }, visible: null });
        expect(result.current.unread[key]).toBe(true);
        rerender({ ws: workspace("/a", "new reply"), visible: target });
        expect(result.current.unread[key]).toBeUndefined();
        rerender({ ws: workspace("/a", "new reply"), visible: null });
        expect(result.current.unread[key]).toBeUndefined();
        rerender({ ws: workspace("/a", "continued reply"), visible: null });
        expect(result.current.unread[key]).toBe(true);
    });

    it("keeps same-id other workspace unread while the visible chat receives replies", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ workspaces }) => useConversationActivity({ workspaces, visibleTarget: target }),
            {
                initialProps: { workspaces: { "/a": workspace(), "/b": workspace("/b") } },
            },
        );
        rerender({
            workspaces: { "/a": workspace("/a", "visible"), "/b": workspace("/b", "background") },
        });
        expect(result.current.unread[key]).toBeUndefined();
        expect(result.current.unread[conversationActivityKey({ ...target, workspace: "/b" })]).toBe(
            true,
        );
    });

    it("ignores historical loads, duplicate replay and metadata revisions; detects recovered new messages", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ ws, visible }) =>
                useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: visible }),
            { initialProps: { ws: workspace(), visible: null as SessionTarget | null } },
        );
        rerender({ ws: workspace("/a", "old history", 50), visible: null });
        expect(result.current.unread[key]).toBeUndefined();
        const recovered = workspace("/a", "recovered reply", 300);
        rerender({ ws: recovered, visible: null });
        expect(result.current.unread[key]).toBe(true);
        rerender({ ws: recovered, visible: target });
        rerender({
            ws: {
                ...recovered,
                sessionStatesById: {
                    same: { ...recovered.sessionStatesById.same, revision: 100 },
                },
            },
            visible: null,
        });
        expect(result.current.unread[key]).toBeUndefined();
    });
});

describe("activity baselines", () => {
    it("baselines a first snapshot even when it contains recent messages", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ ws }) => useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: null }),
            { initialProps: { ws: { ...workspace(), sessionStatesById: {} } as WorkspaceState } },
        );
        const snapshot = workspace("/a", "first snapshot", 200);
        snapshot.sessionStatesById.same.historyLoaded = true;
        rerender({ ws: snapshot });
        expect(result.current.unread[key]).toBeUndefined();
        rerender({ ws: workspace("/a", "new content", 200) });
        expect(result.current.unread[key]).toBe(true);
    });
});

describe("activity cleanup and meaningful changes", () => {
    it("releases only the deleted conversation's unread state", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ workspaces }) => useConversationActivity({ workspaces, visibleTarget: null }),
            {
                initialProps: { workspaces: { "/a": workspace(), "/b": workspace("/b") } },
            },
        );
        rerender({ workspaces: { "/a": workspace("/a", "A"), "/b": workspace("/b", "B") } });
        act(() => result.current.release(target));
        expect(result.current.unread[key]).toBeUndefined();
        expect(result.current.unread[conversationActivityKey({ ...target, workspace: "/b" })]).toBe(
            true,
        );
    });

    it("tracks identities independently even when baseline messages share an array", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const shared: never[] = [];
        const a = workspace();
        const b = workspace("/b");
        a.sessionStatesById.same.messages = shared;
        b.sessionStatesById.same.messages = shared;
        const { result, rerender } = renderHook(
            ({ workspaces }) => useConversationActivity({ workspaces, visibleTarget: null }),
            {
                initialProps: { workspaces: { "/a": a, "/b": b } },
            },
        );
        rerender({ workspaces: { "/a": a, "/b": workspace("/b", "new B") } });
        expect(result.current.unread[conversationActivityKey({ ...target, workspace: "/b" })]).toBe(
            true,
        );
    });

    it("recognizes incoming user messages and thinking updates", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ ws, visible }) =>
                useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: visible }),
            {
                initialProps: { ws: workspace(), visible: null as SessionTarget | null },
            },
        );
        const incoming = workspace();
        incoming.sessionStatesById.same.messages = [
            { id: "remote-user", kind: "user", text: "from IM", ts: 200 },
        ];
        rerender({ ws: incoming, visible: null });
        expect(result.current.unread[key]).toBe(true);
        const thinking = workspace("/a", "", 300);
        thinking.sessionStatesById.same.messages = [
            {
                id: "thinking",
                kind: "assistant",
                text: "",
                ts: 300,
                tools: [],
                thinking: [{ thinking: "first" }],
            },
        ];
        rerender({ ws: thinking, visible: target });
        const continued = workspace();
        continued.sessionStatesById.same.messages = [
            {
                ...thinking.sessionStatesById.same.messages[0],
                thinking: [{ thinking: "continued" }],
            } as never,
        ];
        rerender({ ws: continued, visible: null });
        expect(result.current.unread[key]).toBe(true);
    });
});

describe("live discovery versus hydration", () => {
    it("marks a first-ever live message in an unopened IM chat unread", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const cwd = "im://wecom/alice/new-chat";
        const { result, rerender } = renderHook(
            ({ workspaces }) => useConversationActivity({ workspaces, visibleTarget: target }),
            { initialProps: { workspaces: {} as Record<string, WorkspaceState> } },
        );
        rerender({ workspaces: { [cwd]: workspace(cwd, "new live reply", 200) } });
        expect(
            result.current.unread[conversationActivityKey({ workspace: cwd, sessionId: "same" })],
        ).toBe(true);
    });

    it("does not mark historical tool status repairs unread during snapshot replay", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const historical = workspace("/a", "old reply", 50);
        historical.sessionStatesById.same.historyLoaded = true;
        const assistant = historical.sessionStatesById.same.messages[0];
        if (assistant.kind === "assistant")
            assistant.tools = [{ id: "old-tool", name: "shell", args: {}, status: "running" }];
        const { result, rerender } = renderHook(
            ({ ws }) => useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: null }),
            { initialProps: { ws: historical } },
        );
        const repaired = structuredClone(historical);
        const message = repaired.sessionStatesById.same.messages[0];
        if (message.kind === "assistant") {
            message.tools[0].status = "ok";
            message.tools[0].resultText = "historical result";
        }
        rerender({ ws: repaired });
        expect(result.current.unread[key]).toBeUndefined();
    });
});

describe("read acknowledgement requires attention", () => {
    it("keeps a selected chat unread while blurred and clears it on focus", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const { result, rerender } = renderHook(
            ({ ws }) =>
                useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: target }),
            { initialProps: { ws: workspace() } },
        );
        act(() => {
            vi.mocked(document.hasFocus).mockReturnValue(false);
            window.dispatchEvent(new Event("blur"));
        });
        rerender({ ws: workspace("/a", "arrived while blurred") });
        expect(result.current.unread[key]).toBe(true);
        act(() => {
            vi.mocked(document.hasFocus).mockReturnValue(true);
            window.dispatchEvent(new Event("focus"));
        });
        expect(result.current.unread[key]).toBeUndefined();
    });

    it("keeps a hidden selected chat unread until it is visible and focused", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        const { result, rerender } = renderHook(
            ({ ws }) =>
                useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: target }),
            { initialProps: { ws: workspace() } },
        );
        rerender({ ws: workspace("/a", "arrived while minimized") });
        expect(result.current.unread[key]).toBe(true);
        act(() => window.dispatchEvent(new Event("focus")));
        expect(result.current.unread[key]).toBe(true);
        act(() => {
            visibility.mockReturnValue("visible");
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(result.current.unread[key]).toBeUndefined();
    });
});

describe("ongoing messages across app startup", () => {
    it.each(["running", "idle"] as const)(
        "marks continued text in an old recovered partial unread when execution becomes %s",
        (execution) => {
            vi.spyOn(Date, "now").mockReturnValue(100);
            const partial = workspace("/a", "started before app launch", 50);
            partial.sessionStatesById.same.historyLoaded = true;
            partial.sessionStatesById.same.execution = "running";
            const { result, rerender } = renderHook(
                ({ ws }) =>
                    useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: null }),
                { initialProps: { ws: partial } },
            );
            expect(result.current.unread[key]).toBeUndefined();
            const continued = workspace("/a", "started before app launch; now continued", 50);
            continued.sessionStatesById.same.historyLoaded = true;
            continued.sessionStatesById.same.execution = execution;
            rerender({ ws: continued });
            expect(result.current.unread[key]).toBe(true);
        },
    );

    it("keeps idle historical text corrections read", () => {
        vi.spyOn(Date, "now").mockReturnValue(100);
        const history = workspace("/a", "old history", 50);
        history.sessionStatesById.same.historyLoaded = true;
        history.sessionStatesById.same.execution = "idle";
        const { result, rerender } = renderHook(
            ({ ws }) => useConversationActivity({ workspaces: { "/a": ws }, visibleTarget: null }),
            { initialProps: { ws: history } },
        );
        const repaired = workspace("/a", "corrected old history", 50);
        repaired.sessionStatesById.same.historyLoaded = true;
        repaired.sessionStatesById.same.execution = "idle";
        rerender({ ws: repaired });
        expect(result.current.unread[key]).toBeUndefined();
    });
});
