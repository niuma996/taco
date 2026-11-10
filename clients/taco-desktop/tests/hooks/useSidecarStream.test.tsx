import {
    asSessionId,
    asWorkspaceId,
    PushMethods,
    type ServerPush,
    type SessionEventsGetResult,
} from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../src/components/ToastProvider";
import { getSessionRecoveryTargets, useSidecarStream } from "../../src/hooks/useSidecarStream";
import { useWorkspaces } from "../../src/hooks/useWorkspaces";
import { createSessionState, getSessionState } from "../../src/lib/chat/sessionState";
import { createEmptyWorkspace } from "../../src/lib/chat/workspaceReducer";
import type { TacoClient } from "../../src/lib/clients/tacoClient";

const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (name, handler) => {
        listeners.set(name, handler);
        return () => listeners.delete(name);
    }),
}));
vi.mock("../../src/lib/workspaceStorage", () => ({
    persistActiveCwd: vi.fn(),
    persistCwds: vi.fn(),
    initDefaultCwd: vi.fn(async () => ""),
    getDefaultCwd: () => "",
    isValidWorkspaceCwd: () => true,
    loadActiveCwd: vi.fn(async () => null),
    loadOpenedCwds: vi.fn(async () => []),
    pruneMissingCwds: vi.fn(async (cwds: string[]) => cwds),
    resolveActiveCwd: () => "",
}));
afterEach(() => {
    cleanup();
    listeners.clear();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function frame(sid: string, seq: number): ServerPush {
    return {
        method: "session.event",
        workspace: asWorkspaceId("/w"),
        session: asSessionId(sid),
        seq,
        params: { event: { type: "run_end" } },
    };
}
function replay(events: ServerPush[]): SessionEventsGetResult {
    return { events, firstSeq: 1, lastSeq: events.at(-1)?.seq ?? 0, resetRequired: false };
}
function setup(getEvents = vi.fn(async () => replay([]))) {
    let push!: (p: ServerPush) => void;
    let ready!: (instance?: string) => void;
    const client = {
        onPush: vi.fn((cb) => {
            push = cb;
            return () => {};
        }),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
        onConnectionReady: vi.fn((cb) => {
            ready = cb;
            return () => {};
        }),
        sessionEventsGet: getEvents,
        sessionAttach: vi.fn(async () => ({ execution: "running" as const })),
    } as unknown as TacoClient;
    const onAction = vi.fn();
    const onSnapshotRequired = vi.fn(async () => ({ recovered: false as const }));
    const opts = {
        onAction,
        onSnapshotRequired,
        onLogLine: vi.fn(),
        getRecoveryTargets: () => [
            { cwd: "/w", sid: "A" },
            { cwd: "/w", sid: "B" },
            { cwd: "/w", sid: "C" },
        ],
    };
    renderHook(() => useSidecarStream(client, opts));
    return {
        push: (p: ServerPush) => push(p),
        ready: () => ready("same-instance"),
        onAction,
        getEvents,
        sessionAttach: client.sessionAttach,
    };
}
async function flush() {
    await act(async () => {});
}

describe("useSidecarStream isolation", () => {
    it("probes live execution when reconnect replay misses no lifecycle frame", async () => {
        const h = setup();
        h.ready();
        await flush();
        expect(h.sessionAttach).toHaveBeenCalledTimes(3);
        expect(h.onAction).toHaveBeenCalledWith({
            type: "SET_SESSION_EXECUTION",
            cwd: "/w",
            sid: "A",
            execution: "running",
        });
    });

    it("selects current, running, waiting and unknown caches without scanning historical rows", () => {
        const idle = {
            ...createSessionState(),
            execution: "idle" as const,
            sync: "current" as const,
        };
        const ws = {
            ...createEmptyWorkspace("/w"),
            activeSession: "selected",
            sessionStatesById: {
                selected: idle,
                idle,
                running: { ...idle, execution: "running" as const },
                waiting: { ...idle, askUserPending: { question: true as const } },
                unknown: createSessionState(),
            },
            sessions: [{ id: "historical", createdAt: "2026-01-01" }],
        };
        expect(
            getSessionRecoveryTargets({ "/w": ws }, "/w")
                .map((t) => t.sid)
                .sort(),
        ).toEqual(["running", "selected", "unknown", "waiting"]);
    });

    it("prioritizes selection before offscreen waiting, running and unknown caches", () => {
        const base = {
            ...createSessionState(),
            execution: "idle" as const,
            sync: "current" as const,
        };
        const offscreen = {
            ...createEmptyWorkspace("/other"),
            sessionStatesById: {
                unknown: createSessionState(),
                running: { ...base, execution: "running" as const },
                waiting: { ...base, askUserPending: { question: true as const } },
            },
        };
        const current = {
            ...createEmptyWorkspace("/w"),
            activeSession: "selected",
            sessionStatesById: { selected: base },
        };
        expect(
            getSessionRecoveryTargets({ "/other": offscreen, "/w": current }, "/w").map(
                (t) => t.sid,
            ),
        ).toEqual(["selected", "waiting", "running", "unknown"]);
    });

    it("uses App's helper and real workspace dispatcher to repair a same-instance reconnect with no new push", async () => {
        const readyHandlers = new Set<(instance?: string) => void>();
        let push!: (frame: ServerPush) => void;
        const sessionEventsGet = vi.fn(async ({ workspace, sessionId, afterSeq }) => ({
            events: [{ ...frame(sessionId, afterSeq + 1), workspace }],
            firstSeq: 1,
            lastSeq: afterSeq + 1,
            resetRequired: false,
        }));
        const sessionPrompt = vi.fn();
        const client = {
            onPush: vi.fn((cb) => {
                push = cb;
                return () => {};
            }),
            onWorkspaceEpochChanged: vi.fn(() => () => {}),
            onConnectionReady: vi.fn((cb) => {
                readyHandlers.add(cb);
                return () => readyHandlers.delete(cb);
            }),
            sessionEventsGet,
            sessionPrompt,
        } as unknown as TacoClient;
        const wrapper = ({ children }: { children: ReactNode }) => (
            <ToastProvider>{children}</ToastProvider>
        );
        const { result } = renderHook(
            () => {
                const ws = useWorkspaces(client);
                useSidecarStream(client, {
                    onAction: ws.dispatch,
                    onSnapshotRequired: ws.restoreSessionSnapshot,
                    getRecoveryTargets: () =>
                        getSessionRecoveryTargets(ws.workspaces, ws.activeCwd),
                    onLogLine: vi.fn(),
                });
                return ws;
            },
            { wrapper },
        );
        const running = {
            ...createSessionState(),
            execution: "running" as const,
            sync: "current" as const,
            historyLoaded: true,
        };
        await act(async () =>
            result.current.dispatchWs({
                type: "INIT",
                workspaces: {
                    "/w": {
                        ...createEmptyWorkspace("/w"),
                        listTotal: 0,
                        activeSession: "A",
                        sessionStatesById: { A: running },
                    },
                    "/other": {
                        ...createEmptyWorkspace("/other"),
                        listTotal: 0,
                        sessionStatesById: { B: running },
                    },
                },
            }),
        );
        await act(async () => result.current.switchWorkspace("/w"));
        await act(async () => {
            push({ ...frame("A", 1), params: { event: { type: "run_start" } } });
            push({
                ...frame("B", 1),
                workspace: asWorkspaceId("/other"),
                params: { event: { type: "run_start" } },
            });
        });
        await act(async () => {
            for (const handler of readyHandlers) handler("same-instance");
        });
        expect(
            sessionEventsGet.mock.calls.map(([request]) => [
                request.workspace,
                request.sessionId,
                request.afterSeq,
            ]),
        ).toEqual([
            ["/w", "A", 1],
            ["/other", "B", 1],
        ]);
        expect(getSessionState(result.current.workspaces["/w"], "A")).toMatchObject({
            execution: "idle",
            sync: "current",
        });
        expect(getSessionState(result.current.workspaces["/other"], "B")).toMatchObject({
            execution: "idle",
            sync: "current",
        });
        expect(sessionPrompt).not.toHaveBeenCalled();
    });

    it("lets B flow while A replay waits, and serializes A live frames behind replay", async () => {
        const slow = deferred<SessionEventsGetResult>();
        const getEvents = vi.fn(async () => slow.promise);
        const h = setup(getEvents);
        h.push(frame("A", 3));
        await flush();
        h.push(frame("A", 4));
        h.push(frame("B", 1));
        await flush();
        expect(
            h.onAction.mock.calls.filter(([a]) => a.type === "EVENT").map(([a]) => a.sid),
        ).toEqual(["B"]);
        slow.resolve(replay([frame("A", 1), frame("A", 2), frame("A", 3)]));
        await flush();
        expect(
            h.onAction.mock.calls.filter(([a]) => a.type === "EVENT").map(([a]) => a.sid),
        ).toEqual(["B", "A", "A", "A", "A"]);
        expect(getEvents).toHaveBeenCalledTimes(1);
    });

    it("proactively reconciles on same-instance reconnect without another push, max two requests", async () => {
        const waits = [deferred<SessionEventsGetResult>(), deferred<SessionEventsGetResult>()];
        const getEvents = vi.fn(
            async () => waits[getEvents.mock.calls.length - 1]?.promise ?? replay([frame("C", 1)]),
        );
        const h = setup(getEvents);
        h.ready();
        await flush();
        expect(getEvents).toHaveBeenCalledTimes(2);
        waits[0]?.resolve(replay([frame("A", 1)]));
        await flush();
        expect(getEvents).toHaveBeenCalledTimes(3);
        waits[1]?.resolve(replay([frame("B", 1)]));
        await flush();
        expect(
            h.onAction.mock.calls
                .filter(([a]) => a.type === "EVENT")
                .map(([a]) => a.sid)
                .sort(),
        ).toEqual(["A", "B", "C"]);
    });

    it("ignores old replay after disconnect and does not let it block the new connection", async () => {
        const slow = deferred<SessionEventsGetResult>();
        const getEvents = vi.fn(async () =>
            getEvents.mock.calls.length === 1 ? slow.promise : replay([]),
        );
        const h = setup(getEvents);
        h.push(frame("A", 3));
        await flush();
        listeners.get("sidecar-exited")?.({ payload: {} });
        h.push(frame("B", 1));
        await flush();
        slow.resolve(replay([frame("A", 1), frame("A", 2), frame("A", 3)]));
        await flush();
        expect(
            h.onAction.mock.calls.filter(([a]) => a.type === "EVENT").map(([a]) => a.sid),
        ).toEqual(["B"]);
    });
    it("fences an unsequenced permission recovery callback from the old connection", async () => {
        const old = deferred<SessionEventsGetResult>();
        const getEvents = vi.fn(async () =>
            getEvents.mock.calls.length === 1 ? old.promise : replay([]),
        );
        const h = setup(getEvents);
        const permission = {
            ...frame("A", 1),
            method: PushMethods.CommandPermissionRequested,
            params: { requestId: "same-id" },
        };
        h.push({ ...permission, seq: undefined });
        await flush();
        h.ready();
        await flush();
        old.resolve(replay([permission]));
        await flush();
        expect(
            h.onAction.mock.calls.filter(([a]) => a.type === "COMMAND_PERMISSION_REQUESTED"),
        ).toEqual([]);
    });
});
