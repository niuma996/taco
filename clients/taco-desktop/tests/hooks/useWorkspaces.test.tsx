/**
 * useWorkspaces hook tests — first-turn lifecycle, steer/abort, attachSession
 * failure handling, the notification store, and defaultCwdSettled.
 *
 * The groups share one happy-dom environment; each keeps its own helpers and
 * constants inside its describe block so identifier scope stays per-group.
 */

import { strict as assert } from "node:assert";
import { ErrorCodes } from "@taco-ai/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { beforeEach, describe, it, type Mock, vi } from "vitest";
import { ToastProvider } from "../../src/components/ToastProvider";
import { useConversationDrafts } from "../../src/hooks/useConversationDrafts";
import { useWorkspaces } from "../../src/hooks/useWorkspaces";
import type { WorkspaceState } from "../../src/lib/chat/workspaceReducer";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

vi.mock("../../src/lib/workspaceStorage.ts", () => ({
    initDefaultCwd: vi.fn(async () => ""),
    getDefaultCwd: vi.fn(() => ""),
    isValidWorkspaceCwd: vi.fn((cwd: string) => cwd !== ""),
    loadActiveCwd: vi.fn(async () => null),
    loadOpenedCwds: vi.fn(async () => []),
    persistActiveCwd: vi.fn(async () => {}),
    persistCwds: vi.fn(async () => {}),
    pruneMissingCwds: vi.fn(async (cwds: string[]) => cwds),
    resolveActiveCwd: vi.fn(() => ""),
}));

vi.mock("../../src/hooks/useSidecarStream.ts", () => ({
    sidecarLogListenerReady: Promise.resolve(),
}));

describe("useWorkspacesFirstTurn.test.tsx", () => {
    // The first message of a new session goes through sessionCreate and then the
    // same prompt path every later message uses. A turn that ends badly — a Stop
    // click rejects session.prompt too — must never delete the session: the user's
    // message is already on disk by then, and removing a session is the user's call.
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
            sessionList: vi.fn(async () => ({
                sessions: [] as { id: string; createdAt: string }[],
                total: 0,
            })),
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

    async function renderWithDrafts(client: MockClient) {
        const view = renderHook(() => {
            const workspaces = useWorkspaces(client as unknown as TacoClient);
            const drafts = useConversationDrafts(workspaces.composerTarget);
            useEffect(
                () =>
                    workspaces.onSessionRemoved((target) =>
                        drafts.release({ kind: "session", ...target }),
                    ),
                [workspaces.onSessionRemoved, drafts.release],
            );
            useEffect(
                () =>
                    workspaces.onDraftCreated(({ workspace, draftId, sessionId }) =>
                        drafts.migrateDraft(workspace, draftId, sessionId),
                    ),
                [workspaces.onDraftCreated, drafts.migrateDraft],
            );
            return { ...workspaces, drafts };
        });
        await act(async () => {
            view.result.current.dispatchWs({
                type: "INIT",
                workspaces: { [CWD]: seedEmptyWorkspace() },
            });
            await view.result.current.switchWorkspace(CWD);
        });
        await act(async () => {
            await view.result.current.sendPrompt("create");
        });
        return view;
    }

    describe("useWorkspaces — first turn of a new session", () => {
        beforeEach(() => {
            localStorage.clear();
        });

        it("keeps the composer target stable through renders and workspace updates", async () => {
            const { result, rerender } = await renderSeeded(makeClient());
            const draft = result.current.composerTarget;
            rerender();
            assert.equal(result.current.composerTarget, draft);
            await act(async () => {
                await result.current.sendPrompt("create");
            });
            const session = result.current.composerTarget;
            assert.equal(session.kind, "session");
            rerender();
            assert.equal(result.current.composerTarget, session);
            act(() =>
                result.current.dispatchWs({
                    type: "SET_PENDING",
                    cwd: CWD,
                    sid: NEW_SID,
                    pending: true,
                }),
            );
            assert.equal(result.current.composerTarget, session);
        });

        for (const removal of ["delete", "push", "raw", "not-found"] as const) {
            it(`releases migrated drafts and late callbacks after ${removal} removal`, async () => {
                const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
                const client = makeClient();
                const { result } = await renderWithDrafts(client);
                const old = result.current.drafts;
                const file = {
                    id: "image",
                    name: "image.png",
                    kind: "image" as const,
                    mimeType: "image/png",
                    size: 1,
                    previewUrl: "blob:deleted",
                };
                act(() => {
                    old.setInput("pending");
                    old.setAttachments([file]);
                });
                const submission = old.beginSubmission();
                assert.ok(submission);
                act(() => {
                    old.setInput("");
                    old.setAttachments([]);
                });
                if (removal === "delete") {
                    await act(async () => {
                        await result.current.deleteSession(CWD, NEW_SID);
                    });
                } else if (removal === "not-found") {
                    Object.assign(client, {
                        sessionAttach: vi.fn(async () => {
                            throw Object.assign(new Error("gone"), { code: ErrorCodes.NotFound });
                        }),
                    });
                    await act(async () => {
                        await result.current.attachSession(CWD, NEW_SID);
                    });
                } else {
                    act(() =>
                        result.current[removal === "push" ? "dispatch" : "dispatchWs"]({
                            type: "REMOVE_SESSION",
                            cwd: CWD,
                            sid: NEW_SID,
                        }),
                    );
                }
                assert.equal(result.current.composerTarget.kind, "draft");
                assert.deepEqual(revoke.mock.calls, [["blob:deleted"]]);
                act(() => {
                    result.current.drafts.setInput("new lifetime");
                    old.setInput("late");
                    old.setAttachments([{ ...file, previewUrl: "blob:late" }]);
                    old.completeSubmission(submission, false);
                });
                assert.equal(result.current.drafts.input, "new lifetime");
                assert.deepEqual(result.current.drafts.attachments, []);
                assert.deepEqual(result.current.drafts.recoveries, []);
                assert.deepEqual(revoke.mock.calls, [["blob:deleted"], ["blob:late"]]);
                revoke.mockRestore();
            });
        }

        it("keeps a same-id session in another workspace when a removal arrives", async () => {
            const client = makeClient();
            const { result } = await renderWithDrafts(client);
            act(() => result.current.drafts.setInput("keep this workspace"));
            const setter = result.current.drafts.setInput;
            act(() =>
                result.current.dispatch({ type: "REMOVE_SESSION", cwd: "/other", sid: NEW_SID }),
            );
            assert.equal(result.current.drafts.input, "keep this workspace");
            assert.equal(result.current.composerTarget.kind, "session");
            assert.equal(result.current.drafts.setInput, setter);
        });

        it("retains drafts when a paginated list omits a session or deletion fails", async () => {
            const client = makeClient();
            const { result } = await renderWithDrafts(client);
            act(() => result.current.drafts.setInput("keep"));
            act(() =>
                result.current.dispatchWs({
                    type: "LOAD_SESSIONS",
                    cwd: CWD,
                    sessions: [],
                    total: 20,
                    nextCursor: { id: "other", updatedAt: "2026-01-01T00:00:00Z" },
                }),
            );
            assert.equal(result.current.drafts.input, "keep");
            client.sessionDelete.mockRejectedValueOnce(new Error("delete failed"));
            await act(async () => {
                await result.current.deleteSession(CWD, NEW_SID);
            });
            assert.equal(result.current.drafts.input, "keep");
            assert.equal(result.current.composerTarget.kind, "session");
        });

        it("selects the next session after deletion without releasing its draft", async () => {
            const client = makeClient();
            Object.assign(client, {
                sessionAttach: vi.fn(async () => ({})),
                sessionHistory: vi.fn(async () => ({ entries: [] })),
            });
            const { result } = await renderWithDrafts(client);
            act(() => {
                result.current.drafts.restoreTexts(
                    { kind: "session", workspace: CWD, sessionId: "next" },
                    ["next draft"],
                );
                result.current.dispatchWs({
                    type: "ADD_SESSION",
                    cwd: CWD,
                    session: { id: "next", createdAt: "2026-01-01T00:00:00Z" },
                    makeActive: false,
                });
            });
            await act(async () => {
                await result.current.deleteSession(CWD, NEW_SID);
            });
            assert.deepEqual(result.current.composerTarget, {
                kind: "session",
                workspace: CWD,
                sessionId: "next",
            });
            assert.equal(result.current.drafts.input, "next draft");
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
            assert.equal(
                client.sessionDelete.mock.calls.length,
                0,
                "a stopped turn must not delete",
            );
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
            assert.equal(
                client.sessionDelete.mock.calls.length,
                0,
                "a failed turn must not delete",
            );
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
            const { workspace, sessionId, text } = client.sessionPrompt.mock.calls[0]?.[0] ?? {};
            assert.deepEqual([workspace, sessionId, text], [CWD, NEW_SID, "hello"]);
            assert.equal(result.current.workspaces[CWD]?.activeSession, NEW_SID);
        });

        it("creates and runs a second draft while the first turn is still running", async () => {
            let finishFirst!: () => void;
            const first = new Promise<{ assistantMessage: null }>((resolve) => {
                finishFirst = () => resolve({ assistantMessage: null });
            });
            const client = makeClient({
                sessionCreate: vi
                    .fn()
                    .mockResolvedValueOnce({ sessionId: "a1", filePath: "a1" })
                    .mockResolvedValueOnce({ sessionId: "a2", filePath: "a2" }),
                sessionPrompt: vi
                    .fn()
                    .mockImplementationOnce(() => first)
                    .mockResolvedValue({ assistantMessage: null }),
            });
            const { result } = await renderSeeded(client);
            let running!: Promise<boolean>;
            act(() => {
                running = result.current.sendPrompt("first");
            });
            await waitFor(() => assert.equal(client.sessionPrompt.mock.calls.length, 1));
            act(() => {
                result.current.beginPendingNewSession(CWD);
            });
            let second!: Promise<boolean>;
            act(() => {
                second = result.current.sendPrompt("second");
            });
            await waitFor(() => assert.equal(client.sessionPrompt.mock.calls.length, 2));
            assert.deepEqual(
                client.sessionPrompt.mock.calls.map(([params]) => params.sessionId),
                ["a1", "a2"],
            );
            await act(async () => {
                finishFirst();
                await running;
                await second;
            });
            assert.equal(result.current.workspaces[CWD]?.activeSession, "a2");
        });

        it("does not let an older draft creation select itself over a newer draft", async () => {
            let finishOld!: (value: { sessionId: string; filePath: string }) => void;
            const client = makeClient({
                sessionCreate: vi
                    .fn()
                    .mockImplementationOnce(
                        () =>
                            new Promise((resolve) => {
                                finishOld = resolve;
                            }),
                    )
                    .mockResolvedValue({ sessionId: "newer", filePath: "newer" }),
            });
            const { result } = await renderSeeded(client);
            let old!: Promise<boolean>;
            act(() => {
                old = result.current.sendPrompt("old");
            });
            await waitFor(() => assert.equal(client.sessionCreate.mock.calls.length, 1));
            act(() => {
                result.current.beginPendingNewSession(CWD);
            });
            client.sessionList.mockResolvedValue({
                sessions: [{ id: "newer", createdAt: "2026-01-01" }],
                total: 1,
            });
            await act(async () => {
                await result.current.sendPrompt("new");
            });
            client.sessionList.mockResolvedValue({
                sessions: [
                    { id: "older", createdAt: "2026-01-01" },
                    { id: "newer", createdAt: "2026-01-01" },
                ],
                total: 2,
            });
            await act(async () => {
                finishOld({ sessionId: "older", filePath: "older" });
                await old;
            });
            assert.equal(result.current.workspaces[CWD]?.activeSession, "newer");
            assert.deepEqual(
                new Set(result.current.workspaces[CWD]?.sessions.map((session) => session.id)),
                new Set(["older", "newer"]),
            );
        });

        it("sends to an attached session while its auxiliary state is still loading", async () => {
            let finishTasks!: (value: { active: null; history: never[] }) => void;
            const client = Object.assign(makeClient(), {
                sessionAttach: vi.fn(async () => ({})),
                sessionHistory: vi.fn(async () => ({ entries: [] })),
                sessionTasksGet: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            finishTasks = resolve;
                        }),
                ),
                sessionPlanStateGet: vi.fn(async () => ({ active: false })),
            });
            const { result } = await renderSeeded(client);
            let attaching!: Promise<void>;
            act(() => {
                attaching = result.current.attachSession(CWD, "existing");
            });
            await waitFor(() =>
                assert.equal(result.current.workspaces[CWD]?.activeSession, "existing"),
            );
            await act(async () => {
                await result.current.sendPrompt("on existing");
            });
            assert.equal(client.sessionCreate.mock.calls.length, 0);
            assert.equal(client.sessionPrompt.mock.calls[0]?.[0].sessionId, "existing");
            await act(async () => {
                finishTasks({ active: null, history: [] });
                await attaching;
            });
        });

        it("adopts a created session within its source workspace without navigating away from another project", async () => {
            let create!: (value: { sessionId: string; filePath: string }) => void;
            const client = makeClient({
                sessionCreate: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            create = resolve;
                        }),
                ),
            });
            const { result } = await renderSeeded(client);
            let sending!: Promise<boolean>;
            act(() => {
                sending = result.current.sendPrompt("from a");
            });
            await act(async () => {
                result.current.dispatchWs({ type: "UPSERT_WORKSPACE", cwd: "/b" });
                await result.current.switchWorkspace("/b");
            });
            await act(async () => {
                create({ sessionId: "a1", filePath: "a1" });
                await sending;
            });
            assert.equal(result.current.activeCwd, "/b");
            assert.equal(result.current.workspaces[CWD]?.activeSession, "a1");
            await act(async () => {
                await result.current.switchWorkspace(CWD);
            });
            assert.equal(result.current.composerTarget.kind, "session");
            if (result.current.composerTarget.kind === "session")
                assert.equal(result.current.composerTarget.sessionId, "a1");
        });

        it("creates a fresh conversation after deleting the last session", async () => {
            const client = makeClient();
            const { result } = await renderSeeded(client);
            await act(async () => {
                await result.current.sendPrompt("first conversation");
            });
            await act(async () => {
                await result.current.deleteSession(CWD, NEW_SID);
            });

            assert.equal(result.current.composerTarget.kind, "draft");
            await act(async () => {
                await result.current.sendPrompt(
                    "new conversation",
                    undefined,
                    undefined,
                    result.current.composerTarget,
                );
            });
            assert.equal(client.sessionCreate.mock.calls.length, 2);
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
});

describe("useWorkspacesSteer.test.tsx", () => {
    // Steer/prompt degrade-chain and abort-marker behaviour.
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
            view.result.current.dispatchWs({
                type: "INIT",
                workspaces: { [CWD]: seedWorkspace() },
            });
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

        it("keeps a busy prompt fallback on the original target after navigation", async () => {
            let reject!: (error: Error) => void;
            const client = makeClient({
                sessionPrompt: vi.fn(
                    () =>
                        new Promise((_resolve, fail) => {
                            reject = fail;
                        }),
                ),
            });
            const { result } = await renderSeeded(client);
            let sending!: Promise<boolean>;
            act(() => {
                sending = result.current.sendPrompt("original");
            });
            act(() => {
                result.current.beginPendingNewSession(CWD);
            });
            await act(async () => {
                reject(busyError());
                assert.equal(await sending, true);
            });
            assert.equal(client.sessionSteer.mock.calls[0]?.[0].sessionId, SID);
            assert.equal(result.current.workspaces[CWD]?.activeSession, undefined);
        });

        it("marks transport response loss unknown without making an automatic resend", async () => {
            const client = makeClient({
                sessionPrompt: vi.fn(async () => {
                    throw new Error("socket closed");
                }),
            });
            const { result } = await renderSeeded(client);
            let outcome: string | undefined;
            await act(async () => {
                outcome = await result.current.submitPrompt(
                    { kind: "session", workspace: CWD, sessionId: SID },
                    "maybe submitted",
                    undefined,
                    undefined,
                );
            });
            assert.equal(outcome, "unknown");
            assert.equal(client.sessionPrompt.mock.calls.length, 1);
            assert.equal(
                result.current.workspaces[CWD]?.sessionStatesById?.[SID]?.execution,
                "unknown",
            );
            assert.equal(
                result.current.workspaces[CWD]?.sessionStatesById?.[SID]?.sync,
                "incomplete",
            );
        });

        it("does not let an older prompt response clear a newer running turn", async () => {
            let complete!: (value: { assistantMessage: null }) => void;
            const client = makeClient({
                sessionPrompt: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            complete = resolve;
                        }),
                ),
            });
            const { result } = await renderSeeded(client);
            let first!: Promise<boolean>;
            act(() => {
                first = result.current.sendPrompt("one");
            });
            act(() => {
                result.current.dispatch({
                    type: "EVENT",
                    cwd: CWD,
                    sid: SID,
                    ev: { type: "run_start" },
                });
                result.current.dispatch({
                    type: "EVENT",
                    cwd: CWD,
                    sid: SID,
                    ev: { type: "run_end" },
                });
                result.current.dispatch({
                    type: "EVENT",
                    cwd: CWD,
                    sid: SID,
                    ev: { type: "run_start" },
                });
            });
            await act(async () => {
                complete({ assistantMessage: null });
                await first;
            });
            assert.equal(result.current.workspaces[CWD]?.pendingBySessionId[SID], true);
        });

        it("does not downgrade a newer run when the previous RPC loses its response", async () => {
            let fail!: (error: Error) => void;
            const client = makeClient({
                sessionPrompt: vi.fn(
                    () =>
                        new Promise((_resolve, reject) => {
                            fail = reject;
                        }),
                ),
            });
            const { result } = await renderSeeded(client);
            let sending!: Promise<string>;
            act(() => {
                sending = result.current.submitPrompt(
                    { kind: "session", workspace: CWD, sessionId: SID },
                    "old",
                    undefined,
                    undefined,
                );
            });
            act(() => {
                for (const type of ["run_start", "run_end", "run_start"] as const)
                    result.current.dispatch({ type: "EVENT", cwd: CWD, sid: SID, ev: { type } });
            });
            await act(async () => {
                fail(new Error("response lost"));
                assert.equal(await sending, "unknown");
            });
            assert.equal(
                result.current.workspaces[CWD]?.sessionStatesById?.[SID]?.execution,
                "running",
            );
            assert.equal(result.current.workspaces[CWD]?.pendingBySessionId[SID], true);
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
            const steer = client.sessionSteer.mock.calls[0]?.[0];
            assert.deepEqual(
                [steer?.workspace, steer?.sessionId, steer?.text],
                [CWD, SID, "hello"],
            );
            assert.deepEqual(result.current.notifications, []);
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
            assert.match(result.current.notifications[0]?.text ?? "", /stopped accepting input/);
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
            assert.deepEqual(result.current.notifications, []);
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
            assert.match(result.current.notifications[0]?.text ?? "", /busy/);
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
            assert.deepEqual(result.current.notifications, []);
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
            assert.match(result.current.notifications[0]?.text ?? "", /boom/);
        });
    });
});

describe("useWorkspacesAttach.test.tsx", () => {
    // attachSession's catch block used to drop the session from the sidebar on
    // ANY failure. A no-model / harness / transport error leaves a perfectly valid
    // row on disk; dropping it turned a recoverable error into what looked like
    // lost chat history. Now only RpcHandlerError(NotFound) triggers REMOVE_SESSION.
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
            view.result.current.dispatchWs({
                type: "INIT",
                workspaces: { [CWD]: seedWorkspace() },
            });
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
            assert.ok(
                result.current.notifications.some((n) => n.text.includes("Cannot open session")),
            );
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
                sessionAttach: vi.fn(async ({ sessionId: sid }: { sessionId: string }) => {
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
            assert.ok(
                !ws?.sessions.some((s) => s.id === GONE_SID),
                "not_found must remove the row",
            );
            // The surviving row is untouched.
            assert.ok(ws?.sessions.some((s) => s.id === SID));
            assert.ok(
                result.current.notifications.some((n) => n.text.includes("Cannot open session")),
            );
        });

        it("does not activate or retain an IM workspace when its opener becomes stale", async () => {
            let resolveImList: ((value: { sessions: []; total: number }) => void) | undefined;
            const imList = new Promise<{ sessions: []; total: number }>((resolve) => {
                resolveImList = resolve;
            });
            const client = makeClient({
                sessionList: vi.fn(async ({ workspace: cwd }: { workspace: string }) =>
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
});

describe("useWorkspacesNotifications.test.tsx", () => {
    // The notification list behind the topbar bell. The old error banner showed
    // one message at a time, so a sidecar re-emitting the same `[error]` line per
    // tick cost the user nothing; coalescing is load-bearing rather than cosmetic.
    function makeClient() {
        return {
            start: vi.fn(async () => ({})),
            sessionList: vi.fn(async () => ({ sessions: [], total: 0 })),
            onWorkspaceEpochChanged: vi.fn(() => () => {}),
        };
    }

    function renderStore() {
        const client = makeClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <ToastProvider>{children}</ToastProvider>
        );
        return renderHook(() => useWorkspaces(client as unknown as TacoClient), { wrapper });
    }

    describe("useWorkspaces — notification list", () => {
        beforeEach(() => {
            localStorage.clear();
        });

        it("coalesces a repeated message into one counted row", async () => {
            const { result } = renderStore();

            await act(async () => {
                result.current.pushNotification("disk is full");
            });
            await act(async () => {
                result.current.pushNotification("disk is full");
            });
            await act(async () => {
                result.current.pushNotification("disk is full");
            });

            assert.equal(result.current.notifications.length, 1);
            assert.equal(result.current.notifications[0]?.count, 3);
        });

        it("keeps distinct messages as distinct rows, newest first", async () => {
            const { result } = renderStore();

            await act(async () => {
                result.current.pushNotification("first");
            });
            await act(async () => {
                result.current.pushNotification("second");
            });

            assert.deepEqual(
                result.current.notifications.map((n) => n.text),
                ["second", "first"],
            );
            assert.equal(result.current.notifications[0]?.count, 1);
        });

        it("does not coalesce across kinds", async () => {
            // Same text from two sources is two facts: the onboarding modal filters
            // on `workspace-open`, so merging it into a generic row would make the
            // failure invisible there.
            const { result } = renderStore();

            await act(async () => {
                result.current.pushNotification("boom", { kind: "generic" });
            });
            await act(async () => {
                result.current.pushNotification("boom", { kind: "workspace-open" });
            });

            assert.equal(result.current.notifications.length, 2);
            assert.equal(result.current.notifications[0]?.kind, "workspace-open");
            assert.equal(result.current.notifications[1]?.count, 1);
        });

        it("stops coalescing once the window has passed", async () => {
            vi.useFakeTimers();
            try {
                const { result } = renderStore();

                await act(async () => {
                    result.current.pushNotification("retrying");
                });
                await act(async () => {
                    vi.advanceTimersByTime(11_000);
                });
                await act(async () => {
                    result.current.pushNotification("retrying");
                });

                // Same text, but far enough apart to be two real occurrences.
                assert.equal(result.current.notifications.length, 2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("caps the list and drops the oldest", async () => {
            const { result } = renderStore();

            await act(async () => {
                for (let i = 0; i < 60; i++) {
                    result.current.pushNotification(`message ${i}`);
                }
            });

            assert.equal(result.current.notifications.length, 50);
            assert.equal(result.current.notifications[0]?.text, "message 59");
            assert.equal(result.current.notifications[49]?.text, "message 10");
        });

        it("dismisses one row and clears the rest without touching the other", async () => {
            const { result } = renderStore();

            await act(async () => {
                result.current.pushNotification("keep me");
            });
            await act(async () => {
                result.current.pushNotification("drop me", { kind: "workspace-open" });
            });
            const dropId = result.current.notifications[0]?.id ?? 0;

            await act(async () => {
                result.current.dismissNotification(dropId);
            });

            // The onboarding path drops exactly the banner it rendered; the rest of
            // the history the user has not read yet must survive.
            assert.deepEqual(
                result.current.notifications.map((n) => n.text),
                ["keep me"],
            );

            await act(async () => {
                result.current.clearNotifications();
            });
            assert.deepEqual(result.current.notifications, []);
        });

        it("hands out ids that stay unique as the list churns", async () => {
            // Ids key the rows. A module-level counter is shared by every mounted
            // hook (and survives HMR), so it has to be per-instance; what actually
            // matters is that no two live rows ever share an id.
            const { result } = renderStore();

            await act(async () => {
                for (let i = 0; i < 20; i++) {
                    result.current.pushNotification(`message ${i}`);
                    if (i % 3 === 0) {
                        const oldest =
                            result.current.notifications[result.current.notifications.length - 1];
                        if (oldest) result.current.dismissNotification(oldest.id);
                    }
                }
            });

            const ids = result.current.notifications.map((n) => n.id);
            assert.equal(new Set(ids).size, ids.length);
        });
    });

    it("keeps unopened IM approvals actionable and removes the notice after resolution", async () => {
        const { result } = renderStore();
        const cwd = "im://wechat/u1/u1";
        const request = {
            requestId: "r1",
            sessionId: "s1",
            toolCallId: "t1",
            command: "rm -rf build",
            evaluation: {
                behavior: "ask",
                risk: "destructive",
                reason: "risk",
                matchedList: "deny",
            },
        } as never;
        await act(async () =>
            result.current.dispatch({
                type: "COMMAND_PERMISSION_REQUESTED",
                cwd,
                sid: "s1",
                request,
            }),
        );
        assert.ok(result.current.workspaces[cwd]?.pendingCommandPermissions.r1);
        assert.deepEqual(result.current.notifications[0]?.approval, {
            cwd,
            sessionId: "s1",
            requestId: "r1",
        });
        await act(async () =>
            result.current.dispatch({ type: "COMMAND_PERMISSION_RESOLVED", cwd, requestId: "r1" }),
        );
        assert.equal(result.current.notifications.length, 0);
    });
});

describe("useWorkspacesDefaultCwdSettled.test.tsx", () => {
    // `defaultCwdSettled` means "initDefaultCwd finished", not "it succeeded".
    // App.tsx gates the OnboardingModal on this flag because the modal prefills
    // from `getDefaultCwd()`. On a fresh install the Tauri call fails, so
    // `resolveActiveCwd` returns "" and `activeCwd` stays empty forever — gating
    // on a non-empty cwd would hide onboarding permanently (a soft brick).
    function makeClient() {
        return {
            start: vi.fn(async () => ({})),
            sessionList: vi.fn(async () => ({ sessions: [], total: 0 })),
            onWorkspaceEpochChanged: vi.fn(() => () => {}),
        };
    }

    describe("useWorkspaces — defaultCwdSettled", () => {
        beforeEach(() => {
            localStorage.clear();
        });

        it("flips to true even when initDefaultCwd fails and leaves activeCwd empty", async () => {
            const client = makeClient();
            const wrapper = ({ children }: { children: ReactNode }) => (
                <ToastProvider>{children}</ToastProvider>
            );
            const { result } = renderHook(() => useWorkspaces(client as unknown as TacoClient), {
                wrapper,
            });

            // Starts false: nothing has resolved on the first render, so onboarding
            // must not mount yet.
            assert.equal(result.current.defaultCwdSettled, false);

            await act(async () => {
                await result.current.initFromStorage();
            });

            await waitFor(() => {
                assert.equal(result.current.defaultCwdSettled, true);
            });

            // The precondition that makes this test meaningful: the default really
            // did fail to resolve. If activeCwd were non-empty, gating on it would
            // have been sufficient and this flag would be redundant.
            assert.equal(
                result.current.activeCwd,
                "",
                "test fixture must reproduce the failure case (empty default cwd)",
            );
        });
    });
});

describe("targeted interaction submissions", () => {
    it("waits for success, deduplicates and preserves questions after failure across navigation", async () => {
        const { bootstrapI18n } = await import("../../src/i18n/index");
        bootstrapI18n();
        const { createEmptyWorkspace } = await import("../../src/lib/chat/workspaceReducer");
        let reject!: (error: Error) => void;
        const sessionSubmitAnswers = vi.fn(
            () =>
                new Promise<void>((_, fail) => {
                    reject = fail;
                }),
        );
        const client = {
            sessionSubmitAnswers,
            onWorkspaceEpochChanged: () => () => {},
        } as unknown as TacoClient;
        const { result } = renderHook(() => useWorkspaces(client));
        act(() =>
            result.current.dispatchWs({
                type: "INIT",
                workspaces: {
                    "/a": {
                        ...createEmptyWorkspace("/a"),
                        activeSession: "a",
                        askUserPending: { same: true },
                    },
                    "/b": {
                        ...createEmptyWorkspace("/b"),
                        activeSession: "b",
                        askUserPending: { same: true },
                    },
                },
            }),
        );
        act(() => {
            result.current.setAskUserAnswers(
                "same",
                { answers: { q: "yes" }, questions: [], toolName: "planExit" },
                { workspace: "/a", sessionId: "a" },
            );
            result.current.dispatch({
                type: "ASKUSER_ANSWERED",
                cwd: "/a",
                sid: "a",
                toolCallId: "same",
                answers: { q: "yes" },
            });
            result.current.dispatch({
                type: "ASKUSER_ANSWERED",
                cwd: "/a",
                sid: "a",
                toolCallId: "same",
                answers: { q: "yes" },
            });
        });
        assert.equal(sessionSubmitAnswers.mock.calls.length, 1);
        assert.deepEqual(result.current.workspaces["/a"]?.askUserPending, { same: true });
        await act(async () => reject(new Error("offline")));
        assert.deepEqual(result.current.workspaces["/a"]?.askUserPending, { same: true });
        assert.ok(result.current.notifications[0]?.text.includes("offline"));
        sessionSubmitAnswers.mockImplementation(async () => {});
        await act(async () => {
            result.current.dispatch({
                type: "ASKUSER_ANSWERED",
                cwd: "/a",
                sid: "a",
                toolCallId: "same",
                answers: { q: "yes" },
            });
        });
        assert.deepEqual(result.current.workspaces["/a"]?.askUserPending, {});
        assert.deepEqual(result.current.workspaces["/b"]?.askUserPending, { same: true });
        assert.deepEqual(sessionSubmitAnswers.mock.calls[1], [
            {
                workspace: "/a",
                sessionId: "a",
                toolCallId: "same",
                toolName: "planExit",
                answers: { q: "yes" },
            },
        ]);
    });

    it("restart removes only the affected workspace's approval notifications", () => {
        const { result } = renderHook(() =>
            useWorkspaces({ onWorkspaceEpochChanged: () => () => {} } as unknown as TacoClient),
        );
        act(() => {
            for (const cwd of ["/a", "/b"])
                result.current.pushNotification("approval", {
                    approval: { cwd, sessionId: "s", requestId: cwd },
                });
            result.current.pushNotification("keep this error");
        });
        act(() => result.current.dispatch({ type: "SIDECAR_RESTARTED", cwd: "/a" }));
        assert.equal(result.current.notifications.length, 2);
        assert.equal(
            result.current.notifications.some((n) => n.approval?.cwd === "/a"),
            false,
        );
        assert.equal(
            result.current.notifications.some((n) => n.approval?.cwd === "/b"),
            true,
        );
    });
});

it("drops retired permission replay after replacement but accepts current requests", async () => {
    const { createEmptyWorkspace } = await import("../../src/lib/chat/workspaceReducer");
    const { result } = renderHook(() =>
        useWorkspaces({ onWorkspaceEpochChanged: () => () => {} } as unknown as TacoClient),
    );
    act(() =>
        result.current.dispatchWs({
            type: "INIT",
            workspaces: { "/w": createEmptyWorkspace("/w") },
        }),
    );
    const requested = (requestId: string) =>
        result.current.dispatch({
            type: "COMMAND_PERMISSION_REQUESTED",
            cwd: "/w",
            sid: "s",
            request: { requestId, sessionId: "s", toolCallId: "t" } as never,
        });
    act(() => requested("old"));
    // Replayed requests from the same daemon remain available.
    act(() => requested("old"));
    assert.ok(result.current.workspaces["/w"]?.pendingCommandPermissions.old);
    act(() => result.current.dispatch({ type: "SIDECAR_RESTARTED", cwd: "/w" }));
    act(() => {
        requested("old");
        requested("new");
    });
    assert.deepEqual(
        Object.keys(result.current.workspaces["/w"]?.pendingCommandPermissions ?? {}),
        ["new"],
    );
});
