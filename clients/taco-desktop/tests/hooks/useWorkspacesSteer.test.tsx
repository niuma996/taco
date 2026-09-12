/**
 * useWorkspaces steer/prompt degrade-chain and abort-marker tests.
 *
 * The hook is rendered with a fully mocked TacoClient; Tauri-touching modules
 * (workspaceStorage IPC, the sidecar stderr listener) are stubbed so the hook
 * runs under happy-dom. State is seeded via the exposed dispatchWs (INIT) and
 * switchWorkspace, which is the same path App.tsx uses.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec vitest run tests/hooks/useWorkspacesSteer.test.tsx
 */

import { strict as assert } from "node:assert";
import { ErrorCodes } from "@taco-ai/protocol";
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
const SID = "s1";

function seedWorkspace(): WorkspaceState {
    return {
        cwd: CWD,
        active: true,
        sessions: [{ id: SID, createdAt: "2026-01-01T00:00:00Z" }],
        activeSession: SID,
        messages: [],
        subagentSpawned: {},
        childMessagesBySubSessionId: {},
        childHistoryLoaded: {},
        askUserPending: {},
        agentToolPending: {},
        pendingBySessionId: {},
        queuedBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
    };
}

function busyError(): Error {
    return Object.assign(new Error("session busy"), { code: ErrorCodes.SessionBusy });
}

interface ClientOverrides {
    sessionPrompt?: Mock;
    sessionSteer?: Mock;
    sessionAbort?: Mock;
}

function makeClient(overrides: ClientOverrides = {}) {
    return {
        start: vi.fn(async () => ({})),
        sessionList: vi.fn(async () => ({
            sessions: [{ id: SID, createdAt: "2026-01-01T00:00:00Z" }],
            total: 1,
        })),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
        sessionPrompt: vi.fn(async () => ({ assistantMessage: null })),
        sessionSteer: vi.fn(async () => ({ mode: "queued" as const, entryId: "e1" })),
        sessionAbort: vi.fn(async () => ({ status: "aborted" as const })),
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

describe("useWorkspaces — steer degrade chain", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("session_busy degrades to steerPrompt once and reports success", async () => {
        const client = makeClient({
            sessionPrompt: vi.fn(async () => {
                throw busyError();
            }),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.sendPrompt("hello");
        });
        assert.equal(ok, true);
        assert.equal(client.sessionSteer.mock.calls.length, 1);
        assert.deepEqual(client.sessionSteer.mock.calls[0]?.slice(0, 3), [CWD, SID, "hello"]);
        assert.equal(result.current.errorBanner, null);
    });

    it("busy → steer idle banners instead of re-prompting", async () => {
        const client = makeClient({
            sessionPrompt: vi.fn(async () => {
                throw busyError();
            }),
            sessionSteer: vi.fn(async () => ({ mode: "idle" as const })),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.sendPrompt("hello");
        });
        assert.equal(ok, false);
        // prompt → steer (the one allowed hop) → steer reports idle, but the
        // handoff is already exhausted, so no second prompt fires.
        assert.equal(client.sessionPrompt.mock.calls.length, 1);
        assert.equal(client.sessionSteer.mock.calls.length, 1);
        assert.match(result.current.errorBanner ?? "", /stopped accepting input/);
    });

    it("steer idle hands back to sendPrompt once", async () => {
        const client = makeClient({
            sessionSteer: vi.fn(async () => ({ mode: "idle" as const })),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.steerPrompt("hi");
        });
        assert.equal(ok, true);
        assert.equal(client.sessionPrompt.mock.calls.length, 1);
        assert.equal(result.current.errorBanner, null);
    });

    it("steer → idle → prompt → busy stops after one full round-trip", async () => {
        const client = makeClient({
            sessionSteer: vi.fn(async () => ({ mode: "idle" as const })),
            sessionPrompt: vi.fn(async () => {
                throw busyError();
            }),
        });
        const { result } = await renderSeeded(client);
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.steerPrompt("hi");
        });
        assert.equal(ok, false);
        // steer (idle) → prompt (busy, handoff already exhausted) → banner.
        assert.equal(client.sessionSteer.mock.calls.length, 1);
        assert.equal(client.sessionPrompt.mock.calls.length, 1);
        assert.match(result.current.errorBanner ?? "", /busy/);
    });

    it("the optimistic queue row is retired once the steer RPC settles", async () => {
        const client = makeClient();
        const { result } = await renderSeeded(client);
        await act(async () => {
            await result.current.steerPrompt("queued words");
        });
        // No queue_update push in this harness, so after the RPC settles the
        // queue must be empty — the optimistic row may not linger.
        assert.equal(result.current.workspaces[CWD]?.queuedBySessionId[SID], undefined);
    });
});

describe("useWorkspaces — abort marker lifecycle", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("abort suppresses the in-flight prompt rejection banner", async () => {
        let rejectPrompt: ((err: Error) => void) | undefined;
        const client = makeClient({
            sessionPrompt: vi.fn(
                () =>
                    new Promise<never>((_, reject) => {
                        rejectPrompt = reject;
                    }),
            ),
            sessionAbort: vi.fn(async () => ({
                status: "aborted" as const,
                discardedSteer: ["queued words"],
            })),
        });
        const { result } = await renderSeeded(client);
        let sendResult: Promise<boolean> | undefined;
        await act(async () => {
            sendResult = result.current.sendPrompt("hello");
            // Let sendPrompt reach the await before the abort lands.
            await Promise.resolve();
        });
        let drained: string[] = [];
        await act(async () => {
            drained = await result.current.abortPrompt();
        });
        assert.deepEqual(drained, ["queued words"]);
        let ok: boolean | undefined;
        await act(async () => {
            rejectPrompt?.(new Error("session.prompt aborted"));
            ok = await sendResult;
        });
        assert.equal(ok, false);
        assert.equal(result.current.errorBanner, null);
    });

    it("a successful prompt clears the marker, so a later genuine failure banners", async () => {
        const client = makeClient();
        const { result } = await renderSeeded(client);
        // Mark the sid as user-aborted...
        await act(async () => {
            await result.current.abortPrompt();
        });
        // ...then complete a turn successfully: the marker must be consumed here.
        await act(async () => {
            assert.equal(await result.current.sendPrompt("ok"), true);
        });
        // A later genuine failure must surface, not be misread as user-initiated.
        client.sessionPrompt.mockImplementation(async () => {
            throw new Error("boom");
        });
        let ok: boolean | undefined;
        await act(async () => {
            ok = await result.current.sendPrompt("again");
        });
        assert.equal(ok, false);
        assert.match(result.current.errorBanner ?? "", /boom/);
    });
});
