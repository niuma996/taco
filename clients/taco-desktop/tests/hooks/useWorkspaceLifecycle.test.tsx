import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceLifecycle } from "../../src/hooks/useWorkspaceLifecycle";
import { createSessionState, getSessionState } from "../../src/lib/chat/sessionState";
import {
    createEmptyWorkspace,
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../../src/lib/chat/workspaceReducer";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { SessionPushProcessor } from "../../src/lib/sessionPushProcessor";
import { bindSessionSynchronization } from "../../src/lib/sessionSynchronization";

vi.mock("../../src/hooks/useSidecarStream", () => ({ sidecarLogListenerReady: Promise.resolve() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../src/lib/workspaceStorage", () => ({
    persistActiveCwd: vi.fn(),
    persistCwds: vi.fn(),
    isValidWorkspaceCwd: () => true,
}));
afterEach(cleanup);
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function setup(
    overrides: Record<string, unknown> = {},
    seed: Record<string, WorkspaceState> = { "/w": createEmptyWorkspace("/w") },
    getNavigationVersion?: () => number,
) {
    let ready!: () => void;
    const client = {
        start: vi.fn(async () => {}),
        sessionList: vi.fn(async () => ({ sessions: [], total: 0 })),
        sessionAttach: vi.fn(async () => ({})),
        sessionHistory: vi.fn(async () => ({ entries: [] })),
        sessionTasksGet: vi.fn(async () => ({ active: null, history: [] })),
        sessionPlanStateGet: vi.fn(async () => ({ active: false, currentSlug: null })),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
        onConnectionReady: vi.fn((cb) => {
            ready = cb;
            return () => {};
        }),
        ...overrides,
    };
    const actions: WorkspaceAction[] = [];
    const workspacesRef = { current: seed };
    const setActiveCwd = vi.fn();
    const { result } = renderHook(() =>
        useWorkspaceLifecycle({
            client: client as unknown as TacoClient,
            getNavigationVersion,
            workspacesRef,
            dispatchWs: (a) => {
                actions.push(a);
                workspacesRef.current = workspacesReducer(workspacesRef.current, a);
            },
            activeCwd: "/w",
            setActiveCwd,
            pushNotification: vi.fn(),
        }),
    );
    return { result, client, actions, workspacesRef, setActiveCwd, ready: () => ready() };
}
const flush = async () => {
    await act(async () => {});
};

describe("workspace lifecycle isolation", () => {
    it("opens through the shared snapshot queue and replays new lifecycle frames without stealing a newer draft", async () => {
        let navigation = 0;
        const source = deferred<unknown>();
        const h = setup(
            { sessionSnapshotGet: vi.fn(() => source.promise) },
            undefined,
            () => navigation,
        );
        const processor = new SessionPushProcessor({
            getEvents: async () => ({ events: [], firstSeq: 1, lastSeq: 10, resetRequired: false }),
            recoverSnapshot: (_workspace, _session, kind, _after, _target, isCurrent) =>
                h.result.current.restoreSessionSnapshot("/w", "A", kind, isCurrent),
            deliver: (push) => {
                if (push.seq === 11)
                    h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
                        type: "APPLY_EVENT",
                        cwd: "/w",
                        sid: "A",
                        now: 20,
                        suppressedThinking: false,
                        ev: { type: "run_end" },
                    });
            },
            reportError: (message) => {
                throw new Error(message);
            },
            snapshotRetryDelaysMs: [],
        });
        const unbind = bindSessionSynchronization(h.client, processor);
        try {
            const opening = h.result.current.attachSession("/w", "A");
            await flush();
            navigation++;
            h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
                type: "BEGIN_PENDING_NEW_SESSION",
                cwd: "/w",
                draftId: "newer",
            });
            const push = processor.process({
                method: "session.event",
                workspace: "/w",
                session: "A",
                seq: 11,
                params: { event: { type: "run_end" } },
            } as never);
            source.resolve({
                history: { entries: [] },
                sessionKind: "main",
                snapshotSeq: 10,
                runtime: {
                    operation: { id: "run", kind: "run", status: "open", startedAt: 1 },
                    partialMessage: {
                        role: "assistant",
                        timestamp: 12,
                        content: [{ type: "text", text: "partial" }],
                    },
                    tools: [],
                    queues: [],
                    pendingCommandPermissions: [],
                    inFlightAgentToolCallIds: [],
                    settledBackgroundSubSessionIds: [],
                    pendingAskUserToolCallIds: [],
                },
            });
            await opening;
            await push;
            expect(h.client.sessionAttach).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: "A" }),
            );
            expect(h.client.sessionHistory).not.toHaveBeenCalled();
            expect(h.workspacesRef.current["/w"]?.draftId).toBe("newer");
            expect(getSessionState(h.workspacesRef.current["/w"], "A")).toMatchObject({
                execution: "idle",
                operation: null,
                messages: [{ text: "partial" }],
            });
            expect(processor.last("/w", "A")).toBe(11);
        } finally {
            unbind();
        }
    });

    it("atomically restores runtime queues, partial text and effective permissions on the original target", async () => {
        const permission = {
            requestId: "new",
            sessionId: "A",
            toolCallId: "tool",
            command: "sleep",
            evaluation: {},
        };
        const h = setup({
            sessionSnapshotGet: vi.fn(async () => ({
                history: { entries: [] },
                sessionKind: "main",
                snapshotSeq: 20,
                tasks: { active: null, history: [] },
                planState: { active: true, currentSlug: "plan" },
                runtime: {
                    operation: { id: "operation", kind: "run", status: "running", startedAt: 1 },
                    partialMessage: {
                        role: "assistant",
                        timestamp: 12,
                        content: [{ type: "text", text: "partial" }],
                    },
                    tools: [],
                    queues: [
                        {
                            entryId: "queued",
                            kind: "followUp",
                            message: { role: "user", content: "next" },
                        },
                    ],
                    pendingCommandPermissions: [permission],
                    inFlightAgentToolCallIds: [],
                    settledBackgroundSubSessionIds: [],
                    pendingAskUserToolCallIds: [],
                },
            })),
        });
        const original = h.workspacesRef.current["/w"];
        if (!original) throw new Error("missing workspace fixture");
        original.pendingCommandPermissions = {
            old: { ...permission, requestId: "old" },
            other: { ...permission, requestId: "other", sessionId: "B" },
        } as never;
        original.activeSession = "B";
        await h.result.current.restoreSessionSnapshot("/w", "A", "main");
        const ws = h.workspacesRef.current["/w"];
        if (!ws) throw new Error("missing restored workspace");
        expect(ws.activeSession).toBe("B");
        expect(getSessionState(ws, "A")).toMatchObject({
            execution: "running",
            operation: { id: "operation" },
            messages: [{ text: "partial" }],
            sync: "recovering",
        });
        expect(ws.queuedBySessionId.A).toEqual([{ id: "queued", kind: "followUp", text: "next" }]);
        expect(Object.keys(ws.pendingCommandPermissions).sort()).toEqual(["new", "other"]);
        expect(ws.planStatesBySessionId.A?.currentSlug).toBe("plan");
    });

    for (const [initial, event, expected] of [
        ["idle", "run_start", "running"],
        ["running", "run_end", "idle"],
    ] as const) {
        it(`keeps newer ${event} execution while an older history request finishes`, async () => {
            const history = deferred<{ entries: [] }>();
            const h = setup({
                sessionAttach: vi.fn(async () => ({ execution: initial })),
                sessionHistory: vi.fn(() => history.promise),
            });
            const opening = h.result.current.attachSession("/w", "A");
            await flush();
            h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
                type: "APPLY_EVENT",
                cwd: "/w",
                sid: "A",
                suppressedThinking: false,
                now: 1,
                ev: { type: event },
            });
            history.resolve({ entries: [] });
            await opening;
            expect(getSessionState(h.workspacesRef.current["/w"], "A")?.execution).toBe(expected);
            expect(Boolean(h.workspacesRef.current["/w"]?.pendingBySessionId.A)).toBe(
                expected === "running",
            );
        });
    }

    it("does not reuse an idle cached conversation after reconnect without checking the server", async () => {
        const ws = createEmptyWorkspace("/w");
        ws.sessionStatesById = {
            A: {
                ...createSessionState(),
                historyLoaded: true,
                sync: "current",
                execution: "idle",
            },
        };
        const h = setup({}, { "/w": ws });
        h.ready();
        await h.result.current.attachSession("/w", "A");
        expect(h.client.sessionAttach).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "A" }),
        );
        expect(h.client.sessionHistory).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "A" }),
        );
    });

    it("hydrates A locally when B attach finishes first without stealing selection", async () => {
        const a = deferred<{ entries: [] }>();
        const h = setup({
            sessionHistory: vi.fn(({ sessionId }) =>
                sessionId === "A" ? a.promise : Promise.resolve({ entries: [] }),
            ),
        });
        const first = h.result.current.attachSession("/w", "A");
        await flush();
        await h.result.current.attachSession("/w", "B");
        a.resolve({ entries: [] });
        await first;
        expect(h.workspacesRef.current["/w"]?.activeSession).toBe("B");
        expect(h.workspacesRef.current["/w"]?.sessionStatesById?.A?.historyLoaded).toBe(true);
        const installs = h.actions.filter((a) => a.type === "ATTACH");
        expect(installs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ sid: "A", makeActive: false }),
                expect.objectContaining({ sid: "B", makeActive: true }),
            ]),
        );
    });

    it("uses the caller's navigation clock to keep a later draft selected", async () => {
        let navigation = 0;
        const history = deferred<{ entries: [] }>();
        const h = setup(
            { sessionHistory: vi.fn(() => history.promise) },
            undefined,
            () => navigation,
        );
        const attaching = h.result.current.attachSession("/w", "A");
        await flush();
        navigation++;
        h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
            type: "BEGIN_PENDING_NEW_SESSION",
            cwd: "/w",
            draftId: "new-draft",
        });
        history.resolve({ entries: [] });
        await attaching;
        expect(h.workspacesRef.current["/w"]?.activeSession).toBeUndefined();
        expect(h.workspacesRef.current["/w"]?.draftId).toBe("new-draft");
        expect(h.workspacesRef.current["/w"]?.sessionStatesById?.A?.historyLoaded).toBe(true);
    });

    it("reuses a complete cache without another attach or history request", async () => {
        const ws = createEmptyWorkspace("/w");
        const h = setup(
            {},
            {
                "/w": {
                    ...ws,
                    sessionStatesById: {
                        A: {
                            ...createSessionState(),
                            execution: "idle",
                            historyLoaded: true,
                            sync: "current",
                        },
                    },
                } as WorkspaceState,
            },
        );
        await h.result.current.attachSession("/w", "A");
        expect(h.client.sessionHistory).not.toHaveBeenCalled();
        expect(h.client.sessionAttach).not.toHaveBeenCalled();
        expect(h.actions).toContainEqual(
            expect.objectContaining({ type: "ATTACH", sid: "A", makeActive: true }),
        );
    });

    it("reconciles execution when a complete cache still has unknown run state", async () => {
        const ws = createEmptyWorkspace("/w");
        const h = setup(
            {
                sessionAttach: vi.fn(async () => ({ execution: "idle" })),
            },
            {
                "/w": {
                    ...ws,
                    sessionStatesById: {
                        A: { ...createSessionState(), historyLoaded: true, sync: "current" },
                    },
                } as WorkspaceState,
            },
        );
        await h.result.current.attachSession("/w", "A");
        expect(h.client.sessionAttach).toHaveBeenCalledTimes(1);
        expect(getSessionState(h.workspacesRef.current["/w"], "A")?.execution).toBe("idle");
    });

    it("keeps a newer TASKS_UPDATED when the attach task pull returns late", async () => {
        const tasks = deferred<{ active: null; history: [] }>();
        const h = setup({ sessionTasksGet: vi.fn(() => tasks.promise) });
        const attaching = h.result.current.attachSession("/w", "A");
        await flush();
        expect(h.client.sessionTasksGet).toHaveBeenCalledTimes(1);
        const history = [{ id: "live", name: "Latest tasks", taskCount: 2, completedCount: 1 }];
        h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
            type: "TASKS_UPDATED",
            cwd: "/w",
            sid: "A",
            active: null,
            history,
        });
        const latest = h.workspacesRef.current["/w"]?.taskSnapshotsBySessionId.A;
        tasks.resolve({ active: null, history: [] });
        await attaching;
        expect(h.workspacesRef.current["/w"]?.taskSnapshotsBySessionId.A).toBe(latest);
        expect(h.workspacesRef.current["/w"]?.taskSnapshotsBySessionId.A?.history).toEqual(history);
        expect(h.client.sessionPlanStateGet).toHaveBeenCalledTimes(1);
    });

    it("keeps a newer PLAN_STATE_UPDATED when the attach plan pull returns late", async () => {
        const plan = deferred<{ active: boolean; currentSlug: string | null }>();
        const h = setup({ sessionPlanStateGet: vi.fn(() => plan.promise) });
        const attaching = h.result.current.attachSession("/w", "A");
        await flush();
        expect(h.client.sessionPlanStateGet).toHaveBeenCalledTimes(1);
        h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
            type: "PLAN_STATE_UPDATED",
            cwd: "/w",
            sid: "A",
            active: true,
            currentSlug: "latest-plan",
        });
        const latest = h.workspacesRef.current["/w"]?.planStatesBySessionId.A;
        plan.resolve({ active: false, currentSlug: "old-plan" });
        await attaching;
        expect(h.workspacesRef.current["/w"]?.planStatesBySessionId.A).toBe(latest);
    });

    it("still hydrates attach task and plan pulls when only another session changes", async () => {
        const tasks = deferred<{ active: null; history: [] }>();
        const plan = deferred<{ active: boolean; currentSlug: string | null }>();
        const h = setup({
            sessionTasksGet: vi.fn(() => tasks.promise),
            sessionPlanStateGet: vi.fn(() => plan.promise),
        });
        const attaching = h.result.current.attachSession("/w", "A");
        await flush();
        h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
            type: "TASKS_UPDATED",
            cwd: "/w",
            sid: "B",
            active: null,
            history: [],
        });
        tasks.resolve({ active: null, history: [] });
        await flush();
        h.workspacesRef.current = workspacesReducer(h.workspacesRef.current, {
            type: "PLAN_STATE_UPDATED",
            cwd: "/w",
            sid: "B",
            active: true,
            currentSlug: "B-plan",
        });
        plan.resolve({ active: true, currentSlug: "A-plan" });
        await attaching;
        expect(h.workspacesRef.current["/w"]?.taskSnapshotsBySessionId.A).toMatchObject({
            active: null,
            history: [],
        });
        expect(h.workspacesRef.current["/w"]?.planStatesBySessionId.A).toEqual({
            active: true,
            currentSlug: "A-plan",
        });
        expect(h.workspacesRef.current["/w"]?.planStatesBySessionId.B?.currentSlug).toBe("B-plan");
    });

    it("ignores old snapshot results after same-instance reconnect", async () => {
        const old = deferred<unknown>();
        const h = setup({ sessionSnapshotGet: vi.fn(() => old.promise) });
        const restoring = h.result.current.restoreSessionSnapshot("/w", "A", "main");
        h.ready();
        old.resolve({ history: { entries: [] }, sessionKind: "main", snapshotSeq: 9 });
        expect(await restoring).toEqual({ recovered: false });
        expect(h.actions).not.toContainEqual(
            expect.objectContaining({ type: "RESTORE_SESSION_SNAPSHOT" }),
        );
    });

    it("hydrates snapshot target even after navigation to B", async () => {
        const old = deferred<unknown>();
        const h = setup({ sessionSnapshotGet: vi.fn(() => old.promise) });
        const restoring = h.result.current.restoreSessionSnapshot("/w", "A", "main");
        await h.result.current.attachSession("/w", "B");
        old.resolve({ history: { entries: [] }, sessionKind: "main", snapshotSeq: 9 });
        expect(await restoring).toEqual({ recovered: true, snapshotSeq: 9 });
        expect(h.actions).toContainEqual(
            expect.objectContaining({ type: "RESTORE_SESSION_SNAPSHOT", sid: "A" }),
        );
    });

    it("keeps legacy snapshot execution unknown while leaving replay completion to the processor", async () => {
        const h = setup({
            sessionSnapshotGet: vi.fn(async () => ({
                history: { entries: [] },
                sessionKind: "main",
                snapshotSeq: 9,
            })),
        });
        await h.result.current.restoreSessionSnapshot("/w", "A", "main");
        expect(h.actions).toContainEqual({
            type: "SET_SESSION_EXECUTION",
            cwd: "/w",
            sid: "A",
            execution: "unknown",
        });
        expect(h.actions).not.toContainEqual(
            expect.objectContaining({ type: "SET_SESSION_SYNC", sync: "incomplete" }),
        );
        expect(h.workspacesRef.current["/w"]?.sessionStatesById?.A?.execution).toBe("unknown");
        expect(h.workspacesRef.current["/w"]?.sessionStatesById?.A?.sync).toBe("recovering");
        expect(h.workspacesRef.current["/w"]?.pendingBySessionId.A).toBeUndefined();
    });

    it("drops an earlier list response after a later refresh", async () => {
        const old = deferred<{ sessions: []; total: number }>();
        const h = setup({
            sessionList: vi
                .fn()
                .mockReturnValueOnce(old.promise)
                .mockResolvedValueOnce({ sessions: [], total: 2 }),
        });
        const first = h.result.current.refreshSessionList("/w");
        await h.result.current.refreshSessionList("/w");
        old.resolve({ sessions: [], total: 1 });
        await first;
        expect(h.actions.filter((a) => a.type === "LOAD_SESSIONS").map((a) => a.total)).toEqual([
            2,
        ]);
    });

    it("does not let a slow start issue a list that supersedes a later refresh", async () => {
        const starting = deferred<void>();
        const h = setup({
            start: vi.fn(() => starting.promise),
            sessionList: vi.fn(async () => ({ sessions: [], total: 2 })),
        });
        const opening = h.result.current.openWorkspace("/w");
        await flush();
        await h.result.current.refreshSessionList("/w");
        starting.resolve();
        await opening;
        expect(h.client.sessionList).toHaveBeenCalledTimes(1);
    });

    it("opens concurrently with UPSERT and preserves later navigation", async () => {
        const old = deferred<void>();
        const h = setup({
            start: vi.fn((cwd) => (cwd === "/A" ? old.promise : Promise.resolve())),
        });
        const first = h.result.current.openWorkspace("/A");
        await flush();
        await h.result.current.openWorkspace("/B");
        old.resolve();
        await first;
        expect(h.setActiveCwd.mock.calls.map(([cwd]) => cwd)).toEqual(["/B"]);
        expect(h.actions.filter((a) => a.type === "INIT")).toEqual([]);
        expect(h.actions).toContainEqual({ type: "UPSERT_WORKSPACE", cwd: "/A" });
        expect(h.actions).toContainEqual({ type: "UPSERT_WORKSPACE", cwd: "/B" });
    });
});
