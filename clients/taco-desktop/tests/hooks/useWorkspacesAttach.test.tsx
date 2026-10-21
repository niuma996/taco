/**
 * useWorkspaces attachSession — which failures prune a session row.
 *
 * The bug this pins: attachSession's catch block used to drop the session from
 * the sidebar on ANY failure. A no-model / harness / transport error leaves a
 * perfectly valid row on disk; dropping it turned a recoverable error into
 * what looked like lost chat history. Now only RpcHandlerError(NotFound)
 * (the session genuinely does not exist) triggers REMOVE_SESSION; every other
 * failure keeps the row and just surfaces a notification.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec vitest run tests/hooks/useWorkspacesAttach.test.tsx
 */

import { strict as assert } from "node:assert";
import { ErrorCodes } from "@taco-ai/protocol";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, it, vi } from "vitest";
import { ToastProvider } from "../../src/components/ToastProvider";
import { useWorkspaces } from "../../src/hooks/useWorkspaces";
import type { WorkspaceState } from "../../src/lib/chat/workspaceReducer";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

vi.mock("../../src/lib/workspaceStorage.ts", () => ({
    initDefaultCwd: vi.fn(async () => "/default"),
    isValidWorkspaceCwd: vi.fn(() => true),
    loadActiveCwd: vi.fn(async () => null),
    loadOpenedCwds: vi.fn(async () => []),
    persistActiveCwd: vi.fn(async () => {}),
    persistCwds: vi.fn(async () => {}),
    pruneMissingCwds: vi.fn(async (cwds: string[]) => cwds),
    resolveActiveCwd: vi.fn(() => "/ws"),
}));

vi.mock("../../src/hooks/useSidecarStream.ts", () => ({
    sidecarLogListenerReady: Promise.resolve(),
}));

const CWD = "/ws";
const SID = "s1";
const GONE_SID = "s2";
const IM_CWD = "im://wechat/peer/chat";

function seedWorkspace(): WorkspaceState {
    return {
        cwd: CWD,
        active: true,
        sessions: [
            { id: SID, createdAt: "2026-01-01T00:00:00Z" },
            { id: GONE_SID, createdAt: "2026-01-01T00:00:00Z" },
        ],
        activeSession: SID,
        messages: [],
        subagentSpawned: {},
        childMessagesBySubSessionId: {},
        childHistoryLoaded: {},
        askUserPending: {},
        pendingCommandPermissions: {},
        agentToolPending: {},
        backgroundSubagents: {},
        pendingBySessionId: {},
        queuedBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
    };
}

function rpcError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function makeClient(overrides: Record<string, unknown> = {}) {
    return {
        start: vi.fn(async () => ({})),
        sessionList: vi.fn(async () => ({
            sessions: [
                { id: SID, createdAt: "2026-01-01T00:00:00Z" },
                { id: GONE_SID, createdAt: "2026-01-01T00:00:00Z" },
            ],
            total: 2,
        })),
        sessionHistory: vi.fn(async () => ({ entries: [] })),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
        ...overrides,
    };
}

type MockClient = ReturnType<typeof makeClient>;

async function renderSeeded(client: MockClient) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <ToastProvider>{children}</ToastProvider>
    );
    const view = renderHook(() => useWorkspaces(client as unknown as TacoClient), { wrapper });
    await act(async () => {
        view.result.current.dispatchWs({ type: "INIT", workspaces: { [CWD]: seedWorkspace() } });
    });
    await act(async () => {
        await view.result.current.switchWorkspace(CWD);
    });
    return view;
}

describe("useWorkspaces — attachSession failure handling", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("keeps the session row when attach fails with an internal error", async () => {
        const client = makeClient({
            sessionAttach: vi.fn(async () => {
                throw rpcError(
                    "no model available for harness — please configure defaultModel or pass models",
                    ErrorCodes.Internal,
                );
            }),
        });
        const { result } = await renderSeeded(client);

        await act(async () => {
            await result.current.attachSession(CWD, SID);
        });

        // The session row must survive — the failure is recoverable.
        const ws = result.current.workspaces[CWD];
        assert.ok(
            ws?.sessions.some((s) => s.id === SID),
            "session row must be kept",
        );
        // The failure is surfaced as a notification, not silently swallowed.
        assert.ok(result.current.notifications.some((n) => n.text.includes("Cannot open session")));
        assert.ok(
            result.current.notifications.some((n) =>
                n.text.includes("no model available for harness"),
            ),
        );
    });

    it("keeps the session row when attach fails with invalid_state (no model configured)", async () => {
        const client = makeClient({
            sessionAttach: vi.fn(async () => {
                throw rpcError(
                    "no model configured — select a provider and model in Settings",
                    ErrorCodes.InvalidState,
                );
            }),
        });
        const { result } = await renderSeeded(client);

        await act(async () => {
            await result.current.attachSession(CWD, SID);
        });

        const ws = result.current.workspaces[CWD];
        assert.ok(
            ws?.sessions.some((s) => s.id === SID),
            "session row must be kept",
        );
    });

    it("prunes the session row when attach fails with not_found", async () => {
        const client = makeClient({
            sessionAttach: vi.fn(async (_cwd: string, sid: string) => {
                if (sid === GONE_SID) {
                    throw rpcError("session not found", ErrorCodes.NotFound);
                }
                return {};
            }),
        });
        const { result } = await renderSeeded(client);

        await act(async () => {
            await result.current.attachSession(CWD, GONE_SID);
        });

        // The session genuinely does not exist — dropping the row is correct.
        const ws = result.current.workspaces[CWD];
        assert.ok(!ws?.sessions.some((s) => s.id === GONE_SID), "not_found must remove the row");
        // The surviving row is untouched.
        assert.ok(ws?.sessions.some((s) => s.id === SID));
        assert.ok(result.current.notifications.some((n) => n.text.includes("Cannot open session")));
    });

    it("does not activate or retain an IM workspace when its opener becomes stale", async () => {
        let resolveImList: ((value: { sessions: []; total: number }) => void) | undefined;
        const imList = new Promise<{ sessions: []; total: number }>((resolve) => {
            resolveImList = resolve;
        });
        const client = makeClient({
            sessionList: vi.fn(async (cwd: string) =>
                cwd === IM_CWD ? imList : { sessions: [], total: 0 },
            ),
        });
        const { result } = await renderSeeded(client);
        let current = true;
        let opening: Promise<void> | undefined;

        await act(async () => {
            opening = result.current.openImConversation(IM_CWD, SID, () => current);
            await Promise.resolve();
        });

        current = false;
        await act(async () => {
            resolveImList?.({ sessions: [], total: 0 });
            await opening;
        });

        assert.equal(result.current.activeCwd, CWD);
        assert.equal(result.current.workspaces[IM_CWD], undefined);
    });
});
