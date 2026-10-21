/**
 * useWorkspaces first-turn lifecycle tests.
 *
 * The first message of a new session goes through sessionCreate and then the
 * same prompt path every later message uses. A turn that ends badly — a Stop
 * click rejects session.prompt too — must never delete the session: the user's
 * message is already on disk by then, and removing a session is the user's call.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec vitest run tests/hooks/useWorkspacesFirstTurn.test.tsx
 */

import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, it, type Mock, vi } from "vitest";
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
const NEW_SID = "new-session";

/** A workspace with no active session: the next send takes the create path. */
function seedEmptyWorkspace(): WorkspaceState {
    return {
        cwd: CWD,
        active: true,
        sessions: [],
        activeSession: undefined,
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

interface ClientOverrides {
    sessionCreate?: Mock;
    sessionPrompt?: Mock;
    sessionAbort?: Mock;
}

function makeClient(overrides: ClientOverrides = {}) {
    return {
        start: vi.fn(async () => ({})),
        sessionList: vi.fn(async () => ({ sessions: [], total: 0 })),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
        sessionCreate: vi.fn(async () => ({
            sessionId: NEW_SID,
            filePath: "/ws/.pi/new-session.jsonl",
            assistantMessage: null,
        })),
        sessionPrompt: vi.fn(async () => ({ assistantMessage: null })),
        sessionAbort: vi.fn(async () => ({ status: "aborted" as const })),
        sessionDelete: vi.fn(async () => ({ deleted: true })),
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
        view.result.current.dispatchWs({
            type: "INIT",
            workspaces: { [CWD]: seedEmptyWorkspace() },
        });
    });
    await act(async () => {
        await view.result.current.switchWorkspace(CWD);
    });
    return view;
}

describe("useWorkspaces — first turn of a new session", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("keeps the session when the user stops the first turn", async () => {
        let rejectPrompt: ((err: Error) => void) | undefined;
        const client = makeClient({
            sessionPrompt: vi.fn(
                () =>
                    new Promise<never>((_, reject) => {
                        rejectPrompt = reject;
                    }),
            ),
        });
        const { result } = await renderSeeded(client);
        let sendResult: Promise<boolean> | undefined;
        await act(async () => {
            sendResult = result.current.sendPrompt("hello");
            // Let the create resolve and the prompt RPC start.
            await vi.waitFor(() => assert.equal(client.sessionPrompt.mock.calls.length, 1));
        });
        await act(async () => {
            await result.current.abortPrompt();
        });
        let ok: boolean | undefined;
        await act(async () => {
            rejectPrompt?.(new Error("session.prompt aborted"));
            ok = await sendResult;
        });

        assert.equal(ok, false);
        assert.equal(client.sessionDelete.mock.calls.length, 0, "a stopped turn must not delete");
        const ws = result.current.workspaces[CWD];
        assert.deepEqual(
            ws?.sessions.map((s) => s.id),
            [NEW_SID],
            "the session row stays in the sidebar",
        );
        assert.equal(ws?.activeSession, NEW_SID);
        assert.equal(ws?.pendingBySessionId[NEW_SID], false, "pending is cleared");
        assert.deepEqual(result.current.notifications, [], "a user stop is not an error");
    });

    it("keeps the session and reports the error when the first turn fails", async () => {
        const client = makeClient({
            sessionPrompt: vi.fn(async () => {
                throw new Error("provider exploded");
            }),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.sendPrompt("hello");
        });

        assert.equal(ok, false);
        assert.equal(client.sessionDelete.mock.calls.length, 0, "a failed turn must not delete");
        const ws = result.current.workspaces[CWD];
        assert.deepEqual(
            ws?.sessions.map((s) => s.id),
            [NEW_SID],
        );
        assert.equal(ws?.pendingBySessionId[NEW_SID], false);
        assert.match(result.current.notifications[0]?.text ?? "", /provider exploded/);
    });

    it("delivers the staged model and level through the shared prompt path", async () => {
        const client = makeClient();
        const { result } = await renderSeeded(client);
        await act(async () => {
            assert.equal(await result.current.sendPrompt("hello"), true);
        });

        assert.equal(client.sessionCreate.mock.calls.length, 1);
        assert.equal(client.sessionPrompt.mock.calls.length, 1);
        const [workspace, sessionId, text] = client.sessionPrompt.mock.calls[0] ?? [];
        assert.deepEqual([workspace, sessionId, text], [CWD, NEW_SID, "hello"]);
        assert.equal(result.current.workspaces[CWD]?.activeSession, NEW_SID);
    });

    it("reports a create failure without leaving a session behind", async () => {
        const client = makeClient({
            sessionCreate: vi.fn(async () => {
                throw new Error("no model configured");
            }),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.sendPrompt("hello");
        });

        assert.equal(ok, false);
        assert.equal(client.sessionPrompt.mock.calls.length, 0);
        assert.equal(client.sessionDelete.mock.calls.length, 0);
        assert.deepEqual(result.current.workspaces[CWD]?.sessions, []);
        assert.match(result.current.notifications[0]?.text ?? "", /no model configured/);
    });

    it("drops a second send while the first create is in flight", async () => {
        let resolveCreate:
            | ((v: { sessionId: string; filePath: string; assistantMessage: null }) => void)
            | undefined;
        const client = makeClient({
            sessionCreate: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveCreate = resolve;
                    }),
            ),
        });
        const { result } = await renderSeeded(client);
        let first: Promise<boolean> | undefined;
        let second: boolean | undefined;
        await act(async () => {
            first = result.current.sendPrompt("one");
            await Promise.resolve();
            second = await result.current.sendPrompt("two");
        });
        assert.equal(second, false, "the double-Enter is dropped");
        await act(async () => {
            resolveCreate?.({ sessionId: NEW_SID, filePath: "/x", assistantMessage: null });
            await first;
        });
        assert.equal(client.sessionCreate.mock.calls.length, 1);
        assert.equal(client.sessionPrompt.mock.calls.length, 1);
    });
});
