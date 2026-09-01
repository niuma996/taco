/**
 * useWorkspaceLifecycle — opening, switching, attaching, and listing workspaces.
 *
 * Everything here is "get a workspace or session into the right state on the
 * sidecar, then mirror that into the reducer". The prompt/turn path
 * (sendPrompt / abortPrompt) stays in useWorkspaces: it owns the composer's
 * pending semantics and the lazy-create race guard, which have nothing to
 * do with lifecycle. State this hook does not own — the workspaces
 * reducer, activeCwd, error banner — is passed in, so useWorkspaces
 * remains the single place those are declared.
 */

import type { SessionListResult } from "@taco-ai/protocol";
import { SESSION_LIST_DEFAULT_LIMIT } from "@taco-ai/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { bootMark, bootPhase } from "../lib/bootTrace";
import { findPendingAskUserIds, historyToUiMessages } from "../lib/chat/chatUtils";
import {
    createEmptyWorkspace,
    type SessionMeta,
    sortSessionsByUpdatedDesc,
    type WorkspaceAction,
    type WorkspaceState,
} from "../lib/chat/workspaceReducer";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { loadGlobalConfig } from "../lib/globalConfig";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import {
    initDefaultCwd,
    isValidWorkspaceCwd,
    loadActiveCwd,
    loadOpenedCwds,
    persistActiveCwd,
    persistCwds,
    pruneMissingCwds,
    resolveActiveCwd,
} from "../lib/workspaceStorage";
import { sidecarLogListenerReady } from "./useSidecarStream";

/** Map a server session entry to client SessionMeta. */
function toSessionMeta(s: NonNullable<SessionListResult["sessions"]>[number]): SessionMeta {
    return {
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        filePath: s.filePath,
        name: s.name,
    };
}

export interface UseWorkspaceLifecycleApi {
    initFromStorage: () => Promise<void>;
    reloadAllWorkspaces: () => Promise<void>;
    loadMoreSessions: (cwd: string) => Promise<void>;
    openWorkspace: (rawCwd: string) => Promise<boolean>;
    browseAndOpen: () => Promise<void>;
    switchWorkspace: (cwd: string) => Promise<void>;
    attachSession: (cwd: string, sid: string) => Promise<void>;
    openImConversation: (cwd: string, sid: string) => Promise<void>;
    restoreSessionSnapshot: (
        cwd: string,
        sid: string,
        sessionKind: "main" | "subagent",
    ) => Promise<SnapshotRecovery>;
    deleteSession: (cwd: string, sid: string) => Promise<void>;
    renameSession: (cwd: string, sid: string, name: string) => Promise<void>;
    /** Refresh one workspace's session list (sidebar titles) without attaching. */
    refreshSessionList: (cwd: string) => Promise<void>;
    /** Re-attach the given session, reading through a ref so callers created
     *  before this hook's callbacks (e.g. the SidecarAction dispatcher) can
     *  reach the latest closure without a TDZ or stale-capture hazard. */
    attachSessionRef: MutableRefObject<(cwd: string, sid: string) => Promise<void>>;
}

export interface UseWorkspaceLifecycleOptions {
    client: TacoClient;
    dispatchWs: (action: WorkspaceAction) => void;
    /** Latest committed workspaces map, for read-after-write paths. */
    workspacesRef: MutableRefObject<Record<string, WorkspaceState>>;
    activeCwd: string;
    setActiveCwd: (cwd: string) => void;
    setErrorBanner: (msg: string | null) => void;
    showToast: (msg: string, kind: "error") => void;
}

export function useWorkspaceLifecycle({
    client,
    dispatchWs,
    workspacesRef,
    activeCwd,
    setActiveCwd,
    setErrorBanner,
    showToast,
}: UseWorkspaceLifecycleOptions): UseWorkspaceLifecycleApi {
    /** StrictMode double-run guard — see initFromStorage top. */
    const initStartedRef = useRef(false);

    /** Apply a SessionListResult to the reducer. Centralizes the
     *  result→dispatch mapping so initial load, refresh, and load-more share
     *  one place to thread nextCursor + total through. dispatchWs is a
     *  useReducer dispatch, so no deps are needed. */
    const dispatchListResult = useCallback(
        (cwd: string, result: SessionListResult, append: boolean): void => {
            dispatchWs({
                type: "LOAD_SESSIONS",
                cwd,
                sessions: (result.sessions ?? []).map(toSessionMeta),
                nextCursor: result.nextCursor
                    ? { updatedAt: result.nextCursor.updatedAt, id: result.nextCursor.id }
                    : undefined,
                total: result.total,
                append,
            });
        },
        [dispatchWs],
    );

    const loadWorkspaceSessions = useCallback(
        async (cwd: string): Promise<void> => {
            // The stderr listener must be up before the sidecar can emit a
            // startup line, or the first log is dropped (Tauri's event bus
            // is fire-and-forget). initFromStorage awaits this once at mount;
            // any other code path that calls client.start must do the same.
            await sidecarLogListenerReady;
            // debugMode no longer needs to be passed per-call: the Rust host reads
            // it from ~/.taco/desktop.json at spawn time, so every spawn
            // (prewarm, reconnect, Apply & Restart) sees the current value.
            await client.start(cwd);
            // Default page size (no full:true) — pagination must actually page on
            // initial load, not fetch every session up front.
            dispatchListResult(cwd, await client.sessionList(cwd), false);
        },
        [client, dispatchListResult],
    );

    /** Refresh only one workspace's session list (pull latest name etc. for the sidebar).
     * Does NOT `client.start`, attach, or change activeSession. Used after send / rename to
     * refresh sidebar titles. Strictly distinct from `reloadAllWorkspaces` (which force-attaches
     * sessions[0] after a restart) — that one would swap the user's current panel away. */
    const refreshSessionList = useCallback(
        async (cwd: string): Promise<void> => {
            try {
                // Re-fetch as one page sized to what the user has already paged
                // in, so a refresh after a turn keeps an expanded list expanded
                // instead of collapsing it back to the first page.
                const loaded = workspacesRef.current[cwd]?.sessions.length ?? 0;
                const list = await client.sessionList(
                    cwd,
                    loaded > SESSION_LIST_DEFAULT_LIMIT ? { limit: loaded } : undefined,
                );
                dispatchListResult(cwd, list, false);
            } catch (err) {
                console.error("[taco] refreshSessionList failed", cwd, err);
            }
        },
        [client, dispatchListResult, workspacesRef],
    );

    const attachSession = useCallback(
        async (cwd: string, sessionId: string): Promise<void> => {
            let inFlightAgentToolCallIds: string[] | undefined;
            try {
                const attachResult = await client.sessionAttach(cwd, sessionId);
                inFlightAgentToolCallIds = attachResult?.inFlightAgentToolCallIds;
            } catch (err) {
                const msg = `Cannot open session: ${(err as Error).message}`;
                console.error("[taco] sessionAttach failed", cwd, sessionId, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                // The session is gone from the server — prune it from the local list
                // so the sidebar no longer shows a dead entry. REMOVE_SESSION's
                // reducer strips this sid's pendingBySessionId slot in the same
                // commit, so the sidebar's "running" dot clears with the row.
                dispatchWs({ type: "REMOVE_SESSION", cwd, sid: sessionId });
                return;
            }
            let hist: Awaited<ReturnType<typeof client.sessionHistory>>;
            try {
                hist = await client.sessionHistory(cwd, sessionId);
            } catch (err) {
                // sessionAttach succeeded — the session is valid on the sidecar.
                // Only the history pull failed; dispatch an empty ATTACH so the
                // chat panel renders in a known empty state and the user can
                // still send a new turn. Surface the error so the failure isn't
                // silent (Unahandled Promise Rejection escape route from F1).
                const msg = `Cannot load session history: ${(err as Error).message}`;
                console.error("[taco] sessionHistory failed", cwd, sessionId, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                dispatchWs({
                    type: "ATTACH",
                    cwd,
                    sid: sessionId,
                    messages: [],
                    pendingAskUserIds: [],
                });
                return;
            }
            const msgs = historyToUiMessages(
                hist.entries as Parameters<typeof historyToUiMessages>[0],
                { inFlightAgentToolCallIds },
            );
            dispatchWs({
                type: "ATTACH",
                cwd,
                sid: sessionId,
                messages: msgs,
                pendingAskUserIds: findPendingAskUserIds(msgs),
            });
            // tasks / planState fallback — sidecar pushes on session.attached, but we proactively
            // pull once to cover push-channel drops. RPC reads sidecar memory directly.
            //
            // These reads look redundant next to session.snapshot.get (returns history + tasks +
            // planState in one call). Attach deliberately does NOT use snapshot.get: it carries a
            // snapshotSeq that exists to reset the push cursor, and session.attached's sequenced
            // tasks/plan pushes land right after this attach — swapping without reconciling the
            // cursor would discard those pushes as duplicates. Keep the split until push-recovery
            // semantics change deliberately.
            try {
                const r = await client.sessionTasksGet(cwd, sessionId);
                dispatchWs({
                    type: "TASKS_UPDATED",
                    cwd,
                    sid: sessionId,
                    active: r.active,
                    history: r.history,
                });
            } catch {
                /* Older sidecar may lack this RPC — rely on push. */
            }
            try {
                const p = await client.sessionPlanStateGet(cwd, sessionId);
                dispatchWs({
                    type: "PLAN_STATE_UPDATED",
                    cwd,
                    sid: sessionId,
                    active: p.active,
                    currentSlug: p.currentSlug,
                });
            } catch {
                /* Same as above. */
            }
        },
        [client, dispatchWs, setErrorBanner, showToast],
    );

    const attachSessionRef = useRef(attachSession);
    useEffect(() => {
        attachSessionRef.current = attachSession;
    }, [attachSession]);

    // Indirection for the deferred cold-start retry: initFromStorage is declared
    // before reloadAllWorkspaces, so it reaches the reload through this ref
    // rather than naming the later-declared callback (which would be a TDZ
    // error in the deps array).
    const reloadAllWorkspacesRef = useRef<() => Promise<void>>(() => Promise.resolve());

    /** Set when cold start gave up on every retry; consumed by the epoch
     *  handler below once a replacement daemon is actually serving. */
    const pendingSessionReloadRef = useRef(false);

    const switchWorkspace = useCallback(
        async (cwd: string): Promise<void> => {
            setActiveCwd(cwd);
            persistActiveCwd(cwd);
            dispatchWs({ type: "SET_ACTIVE", cwd });
            // Cold start only fetches the active workspace, so switching is
            // where every other workspace gets its first list. `listTotal` is
            // the "never fetched" marker: it stays undefined until a
            // LOAD_SESSIONS lands, which distinguishes an unfetched workspace
            // from one that was fetched and is genuinely empty (total 0). Refetching
            // on every switch would put a `session.list` on a hot UI path.
            let ws = workspacesRef.current[cwd];
            if (ws && ws.listTotal === undefined) {
                try {
                    await loadWorkspaceSessions(cwd);
                    ws = workspacesRef.current[cwd];
                } catch (e) {
                    // Leave the sidebar empty rather than blocking the switch —
                    // the user is already looking at this workspace.
                    console.error("[taco] sessionList failed on switch", cwd, e);
                }
            }
            if (ws && ws.messages.length === 0 && !ws.activeSession && ws.sessions[0]) {
                await attachSession(cwd, ws.sessions[0].id);
            }
        },
        [attachSession, dispatchWs, setActiveCwd, workspacesRef, loadWorkspaceSessions],
    );

    const initFromStorage = useCallback(async () => {
        // StrictMode double-run guard: React 18 dev mount effects run twice. client.start is
        // idempotent (ensuredCwds + shared readiness) and already blocks duplicate spawn, but
        // the full init (sessionList / attach / loadGlobalConfig / dispatch) must not repeat.
        // The in-flight ref guarantees a single run.
        if (initStartedRef.current) return;
        initStartedRef.current = true;
        bootMark("ui.initFromStorage.enter");
        // Block until the stderr listener is up — otherwise startup lines
        // emitted by the sidecar between cmd.spawn and the listener's
        // `await listen(...)` returning are lost. Tauri's event bus is
        // fire-and-forget; there is no replay for late subscribers.
        await bootPhase("ui.sidecarLogListenerReady", () => sidecarLogListenerReady);
        // Resolve the real default cwd ($TACO_HOME/workspace, created on demand)
        // before reading storage — loadOpenedCwds / resolveActiveCwd fall back to
        // it, and the sync placeholder value points at a path that may not exist.
        await bootPhase("ui.initDefaultCwd", () => initDefaultCwd());
        // Read opened + active from desktop.json (via the Rust host). The read
        // also runs the one-shot migration from the legacy localStorage keys,
        // so an upgrade-in-place user lands in the same workspaces as before.
        // pruneMissingCwds stats every opened path — on macOS a path under a
        // TCC-protected ancestor (~/Documents, ~/Desktop) is a candidate stall
        // point, so it is timed apart from the read that feeds it.
        const openedRaw = await bootPhase("ui.loadOpenedCwds", () => loadOpenedCwds());
        const opened = await bootPhase("ui.pruneMissingCwds", () => pruneMissingCwds(openedRaw));
        bootMark("ui.opened", `count=${opened.length} list=${opened.join(",")}`);
        // loadActiveCwd reads the same desktop.json block (separate IPC call so
        // callers that only need active don't pay for the full opened list).
        const storedActive = await bootPhase("ui.loadActiveCwd", () => loadActiveCwd());
        // resolveActiveCwd is a pure function: prefers the stored active, then
        // opened[0], then the default cwd. We still validate storedActive
        // against opened because the desktop.json active can outlive a workspace
        // that was dropped during pruning.
        const activeTarget = resolveActiveCwd(
            storedActive && opened.includes(storedActive) ? storedActive : null,
            opened,
        );
        setActiveCwd(activeTarget);
        // Persist the post-prune list back so a workspace that disappeared
        // between sessions does not get carried forward. Failure is logged but
        // non-fatal — the in-memory `opened` already excludes the dropped ones.
        await persistCwds(opened);
        const placeholder: Record<string, WorkspaceState> = {};
        for (const cwd of opened) {
            placeholder[cwd] = createEmptyWorkspace(cwd, cwd === activeTarget);
        }
        dispatchWs({ type: "INIT", workspaces: placeholder });
        // Pull each workspace's session list directly (bypassing loadWorkspaceSessions's dispatch)
        // so Promise.all gives us the real sessions[0] for default attach.
        // workspacesRef depends on a useEffect sync, so reading after await may still see stale.
        //
        // Sidecar spawn-time env (debugMode → TACO_DEBUG_LLM_PAYLOAD) is now read
        // from ~/.taco/desktop.json by the Rust host at spawn time, so
        // client.start no longer takes options. Local pre-spawn LS reads are
        // still useful for the other client fields (theme, uiLanguage) that
        // drive synchronous UI before the sidecar answers.
        const firstSessionByCwd: Record<string, SessionMeta | undefined> = {};
        // Cold-start barrier: a single `client.start(activeCwd)` first to give prewarm's spawn
        // a beat to finish before any sessionList fires. Without it the per-cwd `Promise.all`
        // races prewarm — prewarm's reap+respawn of a stale daemon takes seconds (Alive → dies
        // mid-reap → Stale → fresh daemon binds), every per-cwd start burns its retry budget
        // on the same daemon, sidebar sits empty for 30+s. After the leader succeeds the daemon
        // is hot and per-cwd ensureWorkspace hits a populated slot in ms.
        //
        // Budget is deliberately SHORT (3 attempts ≈ 4s) — common cold start resolves in 1-3s.
        // If the leader can't get the daemon ready, fall back to a single deferred background
        // retry so the sidebar renders immediately (empty) and self-fills ~5s later.
        const leaderDelays = [0, 1000, 3000];
        let leaderOk = false;
        let leaderLastErr: unknown;
        bootMark("ui.leader.barrier_enter", `cwd=${activeTarget}`);
        for (const [i, delay] of leaderDelays.entries()) {
            if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay));
            }
            try {
                // Each attempt is timed separately: client.start carries its own
                // 10s awaitHandshake ceiling, so 3 attempts can legitimately
                // consume ~34s. Per-attempt marks distinguish "one slow attempt"
                // from "the budget was walked to exhaustion".
                await bootPhase(`ui.leader.start.attempt${i}`, () => client.start(activeTarget));
                leaderOk = true;
                break;
            } catch (err) {
                leaderLastErr = err;
            }
        }
        bootMark("ui.leader.barrier_exit", `ok=${leaderOk}`);
        if (!leaderOk) {
            console.error(
                "[taco] leader start failed (daemon not ready in budget); scheduling background retry",
                activeTarget,
                leaderLastErr,
            );
            // Non-blocking fallback: retry the full load once, well after the
            // cold-start window. If the daemon is just slow (not dead), this
            // fills the sidebar without the user staring at an empty panel;
            // if it's truly dead, the empty state + this error is the signal.
            setTimeout(() => {
                void reloadAllWorkspacesRef.current().catch((e) => {
                    console.error("[taco] background session reload failed", e);
                });
            }, 5000);
        }
        // Pull the active workspace's session list directly so Promise.all gives us the real
        // sessions[0] for default attach; workspacesRef depends on a useEffect sync, so reading
        // after await may still see stale.
        //
        // Sidecar spawn-time env (debugMode → TACO_DEBUG_LLM_PAYLOAD) is read from
        // ~/.taco/desktop.json by the Rust host, so client.start no longer takes options.
        //
        // Only the active workspace is fetched here. Fetching all of `opened` made cold start
        // pay for workspaces the user cannot see: five concurrent session.list calls, each
        // walking that workspace's whole session store on the daemon — that both delayed the
        // one list the sidebar renders and drove daemon memory up, pushing calls past their
        // 15s ceiling. The rest load on demand (see switchWorkspace). Per-cwd retries are now
        // a safety net only — leader barrier usually succeeds on first attempt.
        const delays = [0, 1000, 2000];
        let anyExhausted = false;
        {
            const cwd = activeTarget;
            let lastErr: unknown;
            for (const delay of delays) {
                if (delay > 0) {
                    console.warn(`[taco] retrying start+sessionList for ${cwd} in ${delay}ms`);
                    await new Promise((r) => setTimeout(r, delay));
                }
                try {
                    await bootPhase(`ui.percwd.start[${cwd}]`, () => client.start(cwd));
                    // sessionList is bounded only by rpcTimeoutMs, which
                    // defaults to 1,000,000ms. If the daemon accepts the
                    // connection and completes the handshake but never
                    // answers this call, the await parks here for ~17min
                    // with no error to catch — the mark is how we tell that
                    // apart from a slow-but-answering daemon.
                    const list = await bootPhase(`ui.percwd.sessionList[${cwd}]`, () =>
                        client.sessionList(cwd),
                    );
                    dispatchListResult(cwd, list, false);
                    firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                    lastErr = undefined;
                    break;
                } catch (err) {
                    lastErr = err;
                }
            }
            if (lastErr !== undefined) {
                console.error("[taco] loadWorkspaceSessions failed after retries", cwd, lastErr);
                bootMark(`ui.percwd.exhausted[${cwd}]`);
                anyExhausted = true;
            }
        }
        // Exhausting the per-cwd retries is otherwise terminal: nothing else refetches, so
        // the sidebar stays empty. `leaderOk` fallback above does not cover this — a daemon
        // that was serving when the leader barrier passed and died moments later leaves
        // `leaderOk === true` with every list still unfetched.
        //
        // Arming a timer does not work: retries burn ~45s of FAST_RPC_TIMEOUT_MS and the
        // replacement daemon binds on its own schedule (measured: exhaustion +49.4s,
        // replacement serving +54.1s — a 3s timer fired into the gap and failed twice).
        // Latch the failure instead and let the epoch handler fire the reload when the
        // new daemon has actually answered `initialize`.
        if (anyExhausted) {
            pendingSessionReloadRef.current = true;
        }
        // Sidebar is populated at this point — everything after is the active
        // workspace's chat panel, not the session list the user is waiting on.
        bootMark("ui.sessionlists_done");
        try {
            await bootPhase("ui.loadGlobalConfig", () => loadGlobalConfig(client));
        } catch (e) {
            console.error("[taco] loadGlobalConfig failed", e);
        }
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await bootPhase("ui.attachFirstSession", () =>
                attachSession(activeTarget, firstSession.id),
            );
        }
        bootMark("ui.initFromStorage.done");
    }, [client, attachSession, dispatchListResult, dispatchWs, setActiveCwd]);

    /** Called after sidecar restart — the sidecar process is replaced, so all attached session
     * IDs become invalid in the new process. Refetch every workspace's session list + attach the
     * first, syncing client state with the new sidecar. */
    const reloadAllWorkspaces = useCallback(async (): Promise<void> => {
        const openedCwds = Object.keys(workspacesRef.current);
        // Active cwd lives in desktop.json now (it survives the sidecar restart
        // that triggered this reload — localStorage would also have survived, but
        // we go through the new path to keep both sources in sync).
        const storedActive = await loadActiveCwd();
        const activeTarget = resolveActiveCwd(storedActive, openedCwds);
        const firstSessionByCwd: Record<string, SessionMeta | undefined> = {};
        await Promise.all(
            openedCwds.map(async (cwd) => {
                // Two attempts, because this reload is itself the recovery path:
                // in dev the daemon is replaced often enough that a single call
                // can land in the window between one dying and its replacement
                // binding, and a failure here has nothing behind it.
                for (const delay of [0, 2000]) {
                    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
                    try {
                        const list = await client.sessionList(cwd);
                        dispatchListResult(cwd, list, false);
                        firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                        return;
                    } catch (err) {
                        console.error("[taco] sessionList failed (restart)", cwd, err);
                    }
                }
            }),
        );
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await attachSession(activeTarget, firstSession.id);
        }
    }, [client, attachSession, dispatchListResult, workspacesRef]);

    useEffect(() => {
        reloadAllWorkspacesRef.current = reloadAllWorkspaces;
    }, [reloadAllWorkspaces]);

    // Recovery for a cold start that exhausted its retries (see initFromStorage).
    // The epoch fires only after the replacement daemon answered `initialize`,
    // which is the one moment we know an RPC will reach a serving process — a
    // timer cannot know that. Latch-and-clear so the reload runs once per
    // failed cold start, not on every subsequent daemon replacement.
    useEffect(() => {
        return client.onWorkspaceEpochChanged(() => {
            if (!pendingSessionReloadRef.current) return;
            pendingSessionReloadRef.current = false;
            bootMark("ui.percwd.reload_after_epoch");
            void reloadAllWorkspacesRef.current().catch((e) => {
                console.error("[taco] post-exhaustion session reload failed", e);
            });
        });
    }, [client]);

    const openWorkspace = useCallback(
        async (rawCwd: string): Promise<boolean> => {
            const cwd = rawCwd.trim().replace(/\/+$/, "");
            if (!cwd) return false;
            if (!isValidWorkspaceCwd(cwd)) {
                const msg = `Invalid workspace path: ${JSON.stringify(cwd)} (contains glob or shell metacharacters; use a real directory path)`;
                console.error("[taco] openWorkspace rejected", cwd);
                setErrorBanner(msg);
                showToast(msg, "error");
                return false;
            }
            if (!workspacesRef.current[cwd]) {
                // Build the next cwd list up front and persist it immediately:
                // reading workspacesRef.current right after dispatchWs would be
                // stale and would drop the new cwd from desktop.json.
                const nextCwds = [...Object.keys(workspacesRef.current), cwd];
                dispatchWs({
                    type: "INIT",
                    workspaces: {
                        ...workspacesRef.current,
                        [cwd]: createEmptyWorkspace(cwd),
                    },
                });
                persistCwds(nextCwds);
            }
            try {
                await loadWorkspaceSessions(cwd);
                await switchWorkspace(cwd);
                return true;
            } catch (err) {
                const msg = `Failed to open ${cwd}: ${(err as Error).message}`;
                console.error("[taco] openWorkspace failed", cwd, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                return false;
            }
        },
        [
            dispatchWs,
            loadWorkspaceSessions,
            setErrorBanner,
            showToast,
            switchWorkspace,
            workspacesRef,
        ],
    );

    const browseAndOpen = useCallback(async () => {
        try {
            const picked = await openDialog({ directory: true, multiple: false });
            if (typeof picked === "string" && picked.length > 0) {
                await openWorkspace(picked);
            }
        } catch (err) {
            const msg = `Failed to open folder picker: ${(err as Error).message}`;
            console.error("[taco] browse failed", err);
            setErrorBanner(msg);
        }
    }, [openWorkspace, setErrorBanner]);

    const openImConversation = useCallback(
        async (cwd: string, sid: string): Promise<void> => {
            const addedNew = !workspacesRef.current[cwd];
            // Seed WorkspaceState FIRST — the ATTACH reducer is a no-op without
            // an existing entry, so the order is load-bearing.
            if (addedNew) {
                dispatchWs({
                    type: "INIT",
                    workspaces: {
                        ...workspacesRef.current,
                        [cwd]: createEmptyWorkspace(cwd),
                    },
                });
            }
            const prevActive = activeCwd;
            try {
                // Same path openWorkspace uses: awaits sidecarLogListenerReady,
                // passes debugMode to client.start (read from desktop.json by the Rust host),
                // and loads the workspace sessions for the sidebar.
                // session list. A bare client.start() would leave ws.sessions
                // empty, so the Sidebar would render no sessions for an IM
                // conversation even though the chat itself attached fine.
                await loadWorkspaceSessions(cwd);
                // Activate inline rather than via switchWorkspace: that helper
                // auto-attaches sessions[0] when the workspace has no active
                // session, which would attach the wrong conversation (or flash
                // it) before our own attach lands. It also persists activeCwd,
                // and an im:// key must not reach the desktop.json
                // `workspaces.active` field — the next launch would resolve an
                // activeCwd with no WorkspaceState.
                setActiveCwd(cwd);
                dispatchWs({ type: "SET_ACTIVE", cwd });
                await attachSession(cwd, sid);
            } catch (err) {
                const msg = `Failed to open IM conversation: ${(err as Error).message}`;
                console.error("[taco] openImConversation failed", cwd, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                // Roll back the half-opened workspace so a later retry starts
                // from a clean state instead of a dangling empty entry.
                if (addedNew) {
                    dispatchWs({ type: "REMOVE_WORKSPACE", cwd });
                }
                if (prevActive) {
                    setActiveCwd(prevActive);
                    dispatchWs({ type: "SET_ACTIVE", cwd: prevActive });
                }
            }
        },
        [
            activeCwd,
            attachSession,
            dispatchWs,
            loadWorkspaceSessions,
            setActiveCwd,
            setErrorBanner,
            showToast,
            workspacesRef,
        ],
    );

    const restoreSessionSnapshot = useCallback(
        async (
            cwd: string,
            sessionId: string,
            _sessionKind: "main" | "subagent",
        ): Promise<SnapshotRecovery> => {
            try {
                const snapshot = await client.sessionSnapshotGet(cwd, sessionId);
                const messages = historyToUiMessages(
                    snapshot.history.entries as Parameters<typeof historyToUiMessages>[0],
                );
                dispatchWs({
                    type: "RESTORE_SESSION_SNAPSHOT",
                    cwd,
                    sid: sessionId,
                    sessionKind: snapshot.sessionKind,
                    messages,
                    pendingAskUserIds:
                        snapshot.sessionKind === "main"
                            ? findPendingAskUserIds(messages)
                            : undefined,
                });
                if (snapshot.tasks) {
                    dispatchWs({
                        type: "TASKS_UPDATED",
                        cwd,
                        sid: sessionId,
                        active: snapshot.tasks.active,
                        history: snapshot.tasks.history,
                    });
                }
                if (snapshot.planState) {
                    dispatchWs({
                        type: "PLAN_STATE_UPDATED",
                        cwd,
                        sid: sessionId,
                        active: snapshot.planState.active,
                        currentSlug: snapshot.planState.currentSlug,
                    });
                }
                return { recovered: true, snapshotSeq: snapshot.snapshotSeq };
            } catch (err) {
                console.error("[taco] session snapshot recovery failed", cwd, sessionId, err);
                setErrorBanner(`Session recovery failed: ${(err as Error).message}`);
                return { recovered: false };
            }
        },
        [client, dispatchWs, setErrorBanner],
    );

    const deleteSession = useCallback(
        async (cwd: string, sessionId: string): Promise<void> => {
            try {
                await client.sessionDelete(cwd, sessionId);
            } catch (err) {
                const msg = `Failed to delete session: ${(err as Error).message}`;
                console.error("[taco] deleteSession failed", cwd, sessionId, err);
                setErrorBanner(msg);
                return;
            }
            // workspacesRef is still stale after dispatchWs (sync happens on next render's useEffect),
            // so filter the remaining list on the old ref to avoid attaching to a just-deleted session.
            const existing = workspacesRef.current[cwd];
            const wasActive = existing?.activeSession === sessionId;
            const remaining = (existing?.sessions ?? []).filter((s) => s.id !== sessionId);
            dispatchWs({ type: "REMOVE_SESSION", cwd, sid: sessionId });
            if (wasActive && remaining[0]) {
                await attachSession(cwd, remaining[0].id);
            }
        },
        [client, attachSession, dispatchWs, setErrorBanner, workspacesRef],
    );

    /** Sidebar "load more" handler. Reads the cursor from reducer state and
     *  appends the next page. If the cursor is missing (e.g. a refresh reset
     *  it), the call is a no-op. */
    const loadMoreSessions = useCallback(
        async (cwd: string): Promise<void> => {
            const cursor = workspacesRef.current[cwd]?.listCursor;
            if (!cursor) return;
            try {
                dispatchListResult(cwd, await client.sessionList(cwd, { cursor }), true);
            } catch (err) {
                console.error("[taco] loadMoreSessions failed", cwd, err);
            }
        },
        [client, dispatchListResult, workspacesRef],
    );

    const renameSession = useCallback(
        async (cwd: string, sessionId: string, name: string): Promise<void> => {
            try {
                await client.sessionRename(cwd, sessionId, name);
            } catch (err) {
                const msg = `Failed to rename session: ${(err as Error).message}`;
                console.error("[taco] renameSession failed", cwd, sessionId, err);
                setErrorBanner(msg);
                return;
            }
            // Reload only the current workspace's session list so the sidebar sees the new name.
            // Rename doesn't change the session set/order, so reloadAllWorkspaces (which iterates
            // every cwd and may accidentally attach) is unnecessary; the backend _nameCache was
            // precisely updated by rename, so this list call won't hit disk.
            await refreshSessionList(cwd);
        },
        [client, refreshSessionList, setErrorBanner],
    );

    return {
        initFromStorage,
        reloadAllWorkspaces,
        loadMoreSessions,
        openWorkspace,
        browseAndOpen,
        switchWorkspace,
        attachSession,
        openImConversation,
        restoreSessionSnapshot,
        deleteSession,
        renameSession,
        refreshSessionList,
        attachSessionRef,
    };
}
