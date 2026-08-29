/**
 * useWorkspaceLifecycle — opening, switching, attaching, and listing workspaces.
 *
 * Everything here is "get a workspace or session into the right state on the
 * sidecar, then mirror that into the reducer". The prompt/turn path
 * (sendPrompt / abortPrompt) stays in useWorkspaces: it owns the composer's
 * pending semantics and the lazy-create race guard, which have nothing to do
 * with lifecycle.
 *
 * State this hook does not own — the workspaces reducer, activeCwd, and the
 * error banner — is passed in, so useWorkspaces remains the single place those
 * are declared.
 */

import type { SessionListResult } from "@taco-ai/protocol";
import { SESSION_LIST_DEFAULT_LIMIT } from "@taco-ai/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { findPendingAskUserIds, historyToUiMessages } from "../lib/chatUtils";
import { readClientSettings } from "../lib/clientSettings";
import { loadGlobalConfig } from "../lib/globalConfig";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import {
    createEmptyWorkspace,
    type SessionMeta,
    sortSessionsByUpdatedDesc,
    type WorkspaceAction,
    type WorkspaceState,
} from "../lib/workspaceReducer";
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
            // debugMode is read synchronously from localStorage to avoid depending on cache.client
            // (which may still be empty before loadGlobalConfig runs).
            const settings = readClientSettings();
            await client.start(cwd, {
                debugMode: settings.debugMode,
                llmDumpToFile: settings.llmDumpToFile,
            });
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
            const hist = await client.sessionHistory(cwd, sessionId);
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
            // tasks / planState fallback — sidecar also pushes on session.attached, but we proactively
            // pull once here to cover push-channel drops. RPC reads sidecar memory directly,
            // independent of the push channel.
            //
            // These two single-shot reads look redundant next to session.snapshot.get (which returns
            // history + tasks + planState in one call, and is what restoreSessionSnapshot below uses).
            // Attach deliberately does NOT use it: snapshot.get carries a snapshotSeq that exists to
            // reset the push cursor, and session.attached's own sequenced tasks/plan pushes land right
            // after this attach. Swapping these reads for snapshot.get without also reconciling the
            // cursor would let those pushes be discarded as duplicates. Keep the split until someone
            // is deliberately changing push-recovery semantics.
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

    const switchWorkspace = useCallback(
        async (cwd: string): Promise<void> => {
            setActiveCwd(cwd);
            persistActiveCwd(cwd);
            dispatchWs({ type: "SET_ACTIVE", cwd });
            const ws = workspacesRef.current[cwd];
            if (ws && ws.messages.length === 0 && !ws.activeSession && ws.sessions[0]) {
                await attachSession(cwd, ws.sessions[0].id);
            }
        },
        [attachSession, dispatchWs, setActiveCwd, workspacesRef],
    );

    const initFromStorage = useCallback(async () => {
        // StrictMode double-run guard: React 18 dev mount effects run twice. client.start is
        // idempotent (ensuredCwds + shared readiness) and already blocks duplicate spawn, but
        // the full init (sessionList / attach / loadGlobalConfig / dispatch) must not repeat.
        // The in-flight ref guarantees a single run.
        if (initStartedRef.current) return;
        initStartedRef.current = true;
        // Block until the stderr listener is up — otherwise startup lines
        // emitted by the sidecar between cmd.spawn and the listener's
        // `await listen(...)` returning are lost. Tauri's event bus is
        // fire-and-forget; there is no replay for late subscribers.
        await sidecarLogListenerReady;
        // Resolve the real default cwd ($TACO_HOME/workspace, created on demand)
        // before reading storage — loadOpenedCwds / resolveActiveCwd fall back to
        // it, and the sync placeholder value points at a path that may not exist.
        await initDefaultCwd();
        // Read opened + active from desktop.json (via the Rust host). The read
        // also runs the one-shot migration from the legacy localStorage keys,
        // so an upgrade-in-place user lands in the same workspaces as before.
        const opened = await pruneMissingCwds(await loadOpenedCwds());
        // loadActiveCwd reads the same desktop.json block (separate IPC call so
        // callers that only need active don't pay for the full opened list).
        const storedActive = await loadActiveCwd();
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
        // debugMode / llmDumpToFile / theme / uiLanguage are read synchronously
        // from localStorage here on purpose. They are passed into the
        // client.start() options below, which the Rust host forwards to the
        // sidecar's spawn env (TACO_DEBUG_LLM_PAYLOAD) — so the values must
        // be known before sidecar.ensureWorkspace fires. settings.get is a
        // sidecar RPC and cannot run before the sidecar is up; LS is the only
        // pre-spawn read available. (Workspaces, by contrast, have no
        // pre-spawn constraint and moved to desktop.json — see
        // workspaceStorage.ts.)
        const firstSessionByCwd: Record<string, SessionMeta | undefined> = {};
        const settings = readClientSettings();
        // Retry the whole start+sessionList chain when the sidecar isn't ready
        // yet — on a Vite full-page reload (triggered by JSON / non-component
        // file changes), the sidecar process is often still spinning up and
        // hello doesn't arrive before the 10s timeout. Without retries the
        // cwd's sessions stay empty forever because initStartedRef blocks
        // re-entry. Three attempts with 500/1500/3000ms backoff covers most
        // dev startup windows without leaving the user staring at a dead pane.
        const delays = [0, 500, 1500, 3000];
        await Promise.all(
            opened.map(async (cwd) => {
                let lastErr: unknown;
                for (const delay of delays) {
                    if (delay > 0) {
                        console.warn(`[taco] retrying start+sessionList for ${cwd} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                    }
                    try {
                        await client.start(cwd, {
                            debugMode: settings.debugMode,
                            llmDumpToFile: settings.llmDumpToFile,
                        });
                        const list = await client.sessionList(cwd);
                        dispatchListResult(cwd, list, false);
                        firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                        return;
                    } catch (err) {
                        lastErr = err;
                    }
                }
                console.error("[taco] loadWorkspaceSessions failed after retries", cwd, lastErr);
            }),
        );
        try {
            await loadGlobalConfig(client);
        } catch (e) {
            console.error("[taco] loadGlobalConfig failed", e);
        }
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await attachSession(activeTarget, firstSession.id);
        }
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
                try {
                    const list = await client.sessionList(cwd);
                    dispatchListResult(cwd, list, false);
                    firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                } catch (err) {
                    console.error("[taco] sessionList failed (restart)", cwd, err);
                }
            }),
        );
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await attachSession(activeTarget, firstSession.id);
        }
    }, [client, attachSession, dispatchListResult, workspacesRef]);

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
                // passes debugMode/llmDumpToFile to client.start, and loads the
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
