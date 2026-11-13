/**
 * Normalizes sidecar pushes and stderr into reducer actions.
 * Session pushes are ordered by the sidecar's per-session `seq`: duplicates
 * are dropped, gaps are replayed through `session.events.get`, and bounded-log
 * expiry falls back to an authoritative snapshot. Listener refs still prevent
 * duplicate subscriptions under StrictMode.
 */

import type {
    ChannelStatusEntry,
    CommandPermissionRequest,
    PlanStateUpdatedParams,
    ServerPush,
    SessionRenamedParams,
    SubagentSettledPayload,
    SubagentSpawnedPayload,
    SubagentStartedPayload,
    TaskListMeta,
    TasksUpdatedParams,
    ToolCallEndParams,
    ToolCallStartParams,
    ToolCallUpdateParams,
    WorkspaceAssociationKey,
} from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId, PushMethods } from "@taco-ai/protocol";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import type { SessionEventLike, SessionEventParams } from "../lib/chat/chatUtils";
import { getSessionState } from "../lib/chat/sessionState";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { SessionPushProcessor, type SnapshotRecovery } from "../lib/sessionPushProcessor";
import { bindSessionSynchronization } from "../lib/sessionSynchronization";
import { bannerSeverity, formatForBanner, parseLogLine } from "../lib/sidecarLogLine";
import { useStableCallback } from "./primitives/useStableCallback";

export type SidecarAction =
    | { type: "SESSION_OPERATION_FINISHED"; cwd: string; sid: string; kind: "compaction" }
    | { type: "SESSION_UNCERTAIN"; cwd: string; sid: string }
    | {
          type: "SET_SESSION_EXECUTION";
          cwd: string;
          sid: string;
          execution: "idle" | "running" | "unknown";
      }
    | {
          type: "SET_SESSION_SYNC";
          cwd: string;
          sid: string;
          sync: "recovering" | "current" | "incomplete";
      }
    | { type: "EVENT"; cwd: string; sid: string; ev: SessionEventLike }
    | {
          type: "CHILD_MESSAGE_EVENT";
          cwd: string;
          sid: string;
          ev: SessionEventLike;
      }
    | {
          type: "SUBAGENT_SPAWNED";
          cwd: string;
          parentSessionId: string;
          parentToolCallId: string;
          subSessionId: string;
          agentType: string;
      }
    | {
          type: "SUBAGENT_SETTLED";
          cwd: string;
          parentSessionId: string;
          parentToolCallId: string;
          subSessionId: string;
          agentType: string;
          outcome: "completed" | "error" | "aborted";
          runId?: string;
      }
    | {
          type: "SUBAGENT_STARTED";
          cwd: string;
          parentSessionId: string;
          parentToolCallId: string;
          subSessionId: string;
          agentType: string;
          runId: string;
          messageId?: string;
      }
    | { type: "ATTACHED"; cwd: string; sid: string }
    | {
          type: "COMMAND_PERMISSION_REQUESTED";
          cwd: string;
          sid: string;
          request: CommandPermissionRequest;
      }
    | { type: "COMMAND_PERMISSION_RESOLVED"; cwd: string; requestId: string }
    | { type: "REMOVE_SESSION"; cwd: string; sid: string }
    | { type: "SESSION_RENAMED"; cwd: string; sid: string; name: string }
    | { type: "SIDECAR_RESTARTED"; cwd: string }
    | { type: "ERROR"; cwd?: string; sid?: string; message: string }
    | {
          type: "ASKUSER_ANSWERED";
          cwd: string;
          sid: string;
          toolCallId: string;
          answers: Record<string, string | string[]>;
      }
    | {
          type: "TASKS_UPDATED";
          cwd: string;
          sid: string;
          active: TasksUpdatedParams["active"];
          history: TaskListMeta[];
      }
    | {
          type: "PLAN_STATE_UPDATED";
          cwd: string;
          sid: string;
          active: PlanStateUpdatedParams["active"];
          currentSlug: PlanStateUpdatedParams["currentSlug"];
      };

export interface UseSidecarStreamOpts {
    /** Receives normalized, cursor-ordered push frames. */
    onAction: (action: SidecarAction) => void;
    /** Rebuilds a session from authoritative pull snapshots after log retention expires. */
    onSnapshotRequired: (
        cwd: string,
        sid: string,
        sessionKind: "main" | "subagent",
        isCurrent?: () => boolean,
    ) => Promise<SnapshotRecovery>;
    /** Current + running/waiting/unknown cached sessions; do not enumerate disk history. */
    getRecoveryTargets?: () => readonly {
        cwd: string;
        sid: string;
        sessionKind?: "main" | "subagent";
    }[];
    /**
     * Receives sidecar failures — `[error]` lines plus unformatted stderr that
     * looks like a crash.
     */
    onLogLine: (line: string) => void;
    /**
     * Receives `[warn]` lines. These are degradations, not failures (a skipped
     * corrupt file, a rebuilt cache, an extension override), so the caller
     * should keep them distinguishable from `onLogLine`. Unset means warns are
     * dropped.
     */
    onWarningLine?: (line: string) => void;
    /** Receives `[taco:llm]` stderr lines when debug dumping is enabled. */
    onLlmDumpLine?: (line: string) => void;
    /**
     * Called when sidecar broadcasts `models.changed` (apiKeys / customProviders
     * were updated via settings.write). Desktop should re-pull
     * `providers.list` / `session.listModels` for the given workspace.
     */
    onModelsChanged?: (cwd: string) => void;
    /** Invalidate: a scheduled consolidation changed this workspace's memory. */
    onMemoryChanged?: (cwd: string) => void;
    /** Fired on every IM channel binding transition (QR shown, connected, ...). */
    onChannelStatusChanged?: (channel: ChannelStatusEntry) => void;
    /** Invalidate: a new IM conversation was routed by the sidecar. */
    onConversationsChanged?: () => void;
    /** Invalidate: an IM workspace policy was written. Carries `{channelId}`. */
    onImPolicyChanged?: (channelId: string) => void;
    /**
     * Invalidate: background Works were created or changed. Process-level, so
     * it arrives with no workspace and no session, and its params are empty —
     * the pane re-pulls the whole overview.
     */
    onWorkChanged?: () => void;
    /**
     * Pre-dispose notice: a policy change is about to interrupt live
     * conversations on `channelId`. Reserved for a future desktop warning —
     * the ImPolicyDialog already confirms before saving.
     */
    onImWorkspacesInvalidated?: (channelId: string) => void;
    /** Invalidate: a workspace's associated-directory set was written. */
    onWorkspaceAssociationsChanged?: (key: WorkspaceAssociationKey) => void;
}

/** Recovery candidates come from local runtime caches and selection, never disk history. */
export function getSessionRecoveryTargets(
    workspaces: Record<string, WorkspaceState>,
    activeCwd: string,
): { cwd: string; sid: string; sessionKind: "main" | "subagent" }[] {
    const targets: {
        cwd: string;
        sid: string;
        sessionKind: "main" | "subagent";
        priority: number;
    }[] = [];
    for (const [cwd, ws] of Object.entries(workspaces)) {
        const ids = new Set([
            ...Object.keys(ws.sessionStatesById ?? {}),
            ...Object.keys(ws.pendingBySessionId),
            ...Object.keys(ws.sessionInteractions ?? {}),
            ...Object.keys(ws.childMessagesBySubSessionId),
            ...(cwd === activeCwd && ws.activeSession ? [ws.activeSession] : []),
        ]);
        const waiting = new Set<string>();
        for (const request of Object.values(ws.pendingCommandPermissions)) {
            for (const sid of [request.sessionId, request.displaySessionId]) {
                if (sid) {
                    ids.add(sid);
                    waiting.add(sid);
                }
            }
        }
        for (const sid of ids) {
            const session = getSessionState(ws, sid);
            const selected = cwd === activeCwd && ws.activeSession === sid;
            const needsAnswer =
                waiting.has(sid) || (session && Object.keys(session.askUserPending).length > 0);
            const running =
                ws.pendingBySessionId[sid] ||
                (session &&
                    (session.execution === "running" ||
                        Object.keys(session.agentToolPending).length > 0 ||
                        Object.values(session.backgroundSubagents).includes("running")));
            if (
                selected ||
                needsAnswer ||
                running ||
                (session && (session.execution === "unknown" || session.sync !== "current")) ||
                ws.queuedBySessionId[sid]?.length
            ) {
                targets.push({
                    cwd,
                    sid,
                    sessionKind: session?.kind ?? "main",
                    priority: selected ? 0 : needsAnswer ? 1 : running ? 2 : 3,
                });
            }
        }
    }
    return targets
        .sort((a, b) => a.priority - b.priority)
        .map(({ cwd, sid, sessionKind }) => ({ cwd, sid, sessionKind }));
}

const LLM_DUMP_PREFIX = "[taco:llm]";

// ─── frame normalizer ─────────────────────────────────────────────────────────

/**
 * Normalizes a validated push frame into a workspace reducer action.
 *
 * Exported for `normalizePushFrame.test.ts` — the mapping from wire `outcome`
 * strings to `SidecarAction` fields has no other test surface, and a bad
 * mapping here silently reads a deliberate stop as a completed run.
 */
export function normalizePushFrame(p: ServerPush, dispatch: (a: SidecarAction) => void): void {
    if (!p.workspace || !p.session) return;

    switch (p.method) {
        case PushMethods.CompactionFinished:
            return void dispatch({
                type: "SESSION_OPERATION_FINISHED",
                cwd: p.workspace,
                sid: p.session,
                kind: "compaction",
            });
        case PushMethods.Attached:
            return void dispatch({ type: "ATTACHED", cwd: p.workspace, sid: p.session });
        case PushMethods.SessionDeleted:
            return void dispatch({ type: "REMOVE_SESSION", cwd: p.workspace, sid: p.session });
        case PushMethods.SessionRenamed: {
            const params = (p.params ?? {}) as SessionRenamedParams;
            if (!params.name) return;
            return void dispatch({
                type: "SESSION_RENAMED",
                cwd: p.workspace,
                sid: p.session,
                name: params.name,
            });
        }
        case PushMethods.Error: {
            const errMsg =
                (p.params as { error?: unknown } | undefined)?.error ?? "unknown sidecar error";
            const message = `[session.error] ${String(errMsg)}`;
            console.error("[taco] session.error", p.workspace, p.session, errMsg);
            return void dispatch({ type: "ERROR", cwd: p.workspace, sid: p.session, message });
        }
        case PushMethods.CommandPermissionRequested:
            return void dispatch({
                type: "COMMAND_PERMISSION_REQUESTED",
                cwd: p.workspace,
                sid: p.session,
                request: p.params as CommandPermissionRequest,
            });
        case PushMethods.CommandPermissionResolved: {
            const requestId = (p.params as { requestId?: unknown } | undefined)?.requestId;
            if (typeof requestId !== "string") return;
            return void dispatch({
                type: "COMMAND_PERMISSION_RESOLVED",
                cwd: p.workspace,
                requestId,
            });
        }
        case PushMethods.SubagentSpawned: {
            const params = (p.params ?? {}) as Partial<SubagentSpawnedPayload>;
            const parentToolCallId =
                typeof params.parentToolCallId === "string" ? params.parentToolCallId : "";
            const subSessionId = typeof params.subSessionId === "string" ? params.subSessionId : "";
            const agentType = typeof params.agentType === "string" ? params.agentType : "";
            if (!parentToolCallId || !subSessionId) return;
            return void dispatch({
                type: "SUBAGENT_SPAWNED",
                cwd: p.workspace,
                parentSessionId: p.session,
                parentToolCallId,
                subSessionId,
                agentType,
            });
        }
        case PushMethods.SubagentSettled: {
            const params = (p.params ?? {}) as Partial<SubagentSettledPayload>;
            const parentToolCallId =
                typeof params.parentToolCallId === "string" ? params.parentToolCallId : "";
            const subSessionId = typeof params.subSessionId === "string" ? params.subSessionId : "";
            const agentType = typeof params.agentType === "string" ? params.agentType : "";
            if (!parentToolCallId || !subSessionId) return;
            return void dispatch({
                type: "SUBAGENT_SETTLED",
                cwd: p.workspace,
                parentSessionId: p.session,
                parentToolCallId,
                subSessionId,
                agentType,
                // Explicit allowlist, not a two-way fallback: an unrecognized
                // value must not silently read as "completed" the way a
                // ternary would — that is exactly the bug that made a
                // deliberate stop render as a green checkmark.
                outcome:
                    params.outcome === "aborted"
                        ? "aborted"
                        : params.outcome === "error"
                          ? "error"
                          : "completed",
                ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
            });
        }
        case PushMethods.SubagentStarted: {
            const params = (p.params ?? {}) as Partial<SubagentStartedPayload>;
            if (
                typeof params.parentToolCallId !== "string" ||
                typeof params.subSessionId !== "string" ||
                typeof params.runId !== "string"
            )
                return;
            return void dispatch({
                type: "SUBAGENT_STARTED",
                cwd: p.workspace,
                parentSessionId: p.session,
                parentToolCallId: params.parentToolCallId,
                subSessionId: params.subSessionId,
                agentType: typeof params.agentType === "string" ? params.agentType : "agent",
                runId: params.runId,
                ...(typeof params.messageId === "string" ? { messageId: params.messageId } : {}),
            });
        }
        case PushMethods.TasksUpdated: {
            const params = (p.params ?? {}) as TasksUpdatedParams;
            return void dispatch({
                type: "TASKS_UPDATED",
                cwd: p.workspace,
                sid: p.session,
                active: params.active,
                history: params.history,
            });
        }
        case PushMethods.PlanStateUpdated: {
            const params = (p.params ?? {}) as PlanStateUpdatedParams;
            return void dispatch({
                type: "PLAN_STATE_UPDATED",
                cwd: p.workspace,
                sid: p.session,
                active: params.active,
                currentSlug: params.currentSlug,
            });
        }

        // Build a session event and dispatch as EVENT or CHILD_MESSAGE_EVENT.
        case PushMethods.Event: {
            const ev = (p.params as SessionEventParams | undefined)?.event;
            if (!ev) return;
            return void dispatch(
                p.sessionKind === "subagent"
                    ? { type: "CHILD_MESSAGE_EVENT", cwd: p.workspace, sid: p.session, ev }
                    : { type: "EVENT", cwd: p.workspace, sid: p.session, ev },
            );
        }
        // The three tool pushes are named methods, so the payload carries no
        // `type` discriminant of its own — the method name IS the tag. Add the
        // matching `SessionEventLike` tag and spread the params through: the
        // protocol param interfaces declare exactly the fields the union
        // branches read (plus `ts`, which the renderer ignores), so re-listing
        // them by hand only creates a second place to forget a new field.
        case PushMethods.ToolCallStart: {
            const params = (p.params ?? {}) as ToolCallStartParams;
            return void dispatch({
                type: p.sessionKind === "subagent" ? "CHILD_MESSAGE_EVENT" : "EVENT",
                cwd: p.workspace,
                sid: p.session,
                ev: { type: "tool_start", ...params },
            });
        }
        case PushMethods.ToolCallUpdate: {
            const params = (p.params ?? {}) as ToolCallUpdateParams;
            return void dispatch({
                type: p.sessionKind === "subagent" ? "CHILD_MESSAGE_EVENT" : "EVENT",
                cwd: p.workspace,
                sid: p.session,
                ev: { type: "tool_update", ...params },
            });
        }
        case PushMethods.ToolCallEnd: {
            const params = (p.params ?? {}) as ToolCallEndParams;
            return void dispatch({
                type: p.sessionKind === "subagent" ? "CHILD_MESSAGE_EVENT" : "EVENT",
                cwd: p.workspace,
                sid: p.session,
                ev: { type: "tool_end", ...params },
            });
        }
    }
}

/** Subscribes to sidecar pushes and serializes replay/recovery for each stream.
 *
 * Returns a `ready` promise alongside `clearCursors`; consumers that are
 * about to start the sidecar must `await ready` first so the stderr listener
 * is registered before the child process begins emitting. Without that gate,
 * a startup line written by the sidecar between `cmd.spawn()` and the
 * listener's `await listen(...)` returning would be dropped (Tauri's event
 * bus is fire-and-forget; there is no replay for late subscribers).
 *
 * Implementation note: `ready` is hoisted to module scope so the call order
 * between this hook and `useWorkspaces` doesn't matter — `useWorkspaces`
 * imports the same promise and awaits it before any `client.start`. Without
 * that, the only way to break the circular declaration order would be to
 * register `restoreSessionSnapshot` lazily via a ref. Module-scope is
 * simpler and the test (per-render isolation) doesn't apply here — both
 * hooks live in the same React tree instance. */
const READY_PROMISE: { promise: Promise<void>; resolve: () => void } = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
})();

/** Resolves once `useSidecarStream`'s stderr listener is registered. Await
 * this from any code path that is about to call `client.start`. */
export const sidecarLogListenerReady: Promise<void> = READY_PROMISE.promise;

export function useSidecarStream(
    client: TacoClient,
    opts: UseSidecarStreamOpts,
): { clearCursors: () => void } {
    const onActionRef = useStableCallback(opts.onAction);
    const onSnapshotRequiredRef = useStableCallback(opts.onSnapshotRequired);
    const onLogLineRef = useStableCallback(opts.onLogLine);
    const onWarningLineRef = useStableCallback((line: string) => opts.onWarningLine?.(line));
    const onLlmDumpLineRef = useStableCallback((line: string) => opts.onLlmDumpLine?.(line));
    const onModelsChangedRef = useStableCallback((cwd: string) => opts.onModelsChanged?.(cwd));
    const onMemoryChangedRef = useStableCallback((cwd: string) => opts.onMemoryChanged?.(cwd));
    const onChannelStatusChangedRef = useStableCallback((channel: ChannelStatusEntry) =>
        opts.onChannelStatusChanged?.(channel),
    );
    const onConversationsChangedRef = useStableCallback(() => opts.onConversationsChanged?.());
    const onWorkChangedRef = useStableCallback(() => opts.onWorkChanged?.());
    const onImPolicyChangedRef = useStableCallback((channelId: string) =>
        opts.onImPolicyChanged?.(channelId),
    );
    const onImWorkspacesInvalidatedRef = useStableCallback((channelId: string) =>
        opts.onImWorkspacesInvalidated?.(channelId),
    );
    const onWorkspaceAssociationsChangedRef = useStableCallback((key: WorkspaceAssociationKey) =>
        opts.onWorkspaceAssociationsChanged?.(key),
    );

    const clientRef = useRef(client);
    clientRef.current = client;
    const processorRef = useRef<SessionPushProcessor | undefined>(undefined);
    const getRecoveryTargets = useStableCallback(() => opts.getRecoveryTargets?.() ?? []);
    const recoveryGenerationRef = useRef(0);
    const logUnlistenRef = useRef<UnlistenFn | undefined>(undefined);
    const unsubscribePushRef = useRef<(() => void) | undefined>(undefined);
    // `ready` is created once on first render. The resolve callback is
    // captured by the effect that calls `await listen(...)`; once the
    // listener is registered it fires, and any `client.start` calls that
    // had `await ready` proceed.
    // No per-instance ready state needed — the module-level READY_PROMISE
    // resolves the first time the listener is registered. Subsequent
    // re-renders resolve immediately.

    if (!processorRef.current) {
        processorRef.current = new SessionPushProcessor({
            getEvents: (workspace, session, afterSeq) =>
                clientRef.current.sessionEventsGet({
                    workspace: asWorkspaceId(workspace),
                    sessionId: asSessionId(session),
                    afterSeq,
                }),
            deliver: (push) => normalizePushFrame(push, onActionRef),
            onSyncState: (cwd, sid, sync) =>
                onActionRef({ type: "SET_SESSION_SYNC", cwd, sid, sync }),
            recoverSnapshot: (workspace, session, sessionKind, _lastSeq, _targetSeq, isCurrent) =>
                onSnapshotRequiredRef(workspace, session, sessionKind, isCurrent),
            // Snapshot reads are passive. They certify execution only for a
            // session that is already attached; an unattached session remains
            // unknown until the user explicitly opens it.
            probeExecution: async (workspace, session) => {
                const snapshot = await clientRef.current.sessionSnapshotGet({
                    workspace: asWorkspaceId(workspace),
                    sessionId: asSessionId(session),
                });
                if (!snapshot.runtime) return undefined;
                return snapshot.runtime.operation?.kind === "run" ? "running" : "idle";
            },
            onExecutionState: (cwd, sid, execution) =>
                onActionRef({ type: "SET_SESSION_EXECUTION", cwd, sid, execution }),
            reportError: (message, error) => {
                console.error("[taco] session push recovery", message, error);
                onLogLineRef(`[sidecar] ${message}`);
            },
        });
    }

    useEffect(() => {
        const processor = processorRef.current;
        if (!processor) return;
        const unbindSynchronization = bindSessionSynchronization(client, processor);
        const invalidate = (markUncertain = false) => {
            recoveryGenerationRef.current++;
            processor.invalidate();
            if (markUncertain) {
                for (const { cwd, sid } of getRecoveryTargets())
                    onActionRef({ type: "SESSION_UNCERTAIN", cwd, sid });
            }
        };
        const reportFailure = (error: unknown) => {
            console.error("[taco] push processing failed", error);
            onLogLineRef(`[sidecar] push processing failed: ${String(error)}`);
        };
        const unsubscribeReady = client.onConnectionReady(() => {
            invalidate(true);
            const generation = recoveryGenerationRef.current;
            const unique = new Map(
                getRecoveryTargets().map((target) => [`${target.cwd}\u0000${target.sid}`, target]),
            );
            const targets = [...unique.values()];
            let next = 0;
            const recover = async () => {
                while (generation === recoveryGenerationRef.current && next < targets.length) {
                    const target = targets[next++];
                    if (!target) return;
                    try {
                        await processor.reconcile(target.cwd, target.sid, target.sessionKind);
                    } catch (error) {
                        if (generation === recoveryGenerationRef.current) reportFailure(error);
                    }
                }
            };
            void Promise.all([recover(), recover()]);
        });
        const unsubscribeEpoch = client.onWorkspaceEpochChanged((workspace) => {
            processorRef.current?.resetWorkspace(workspace);
            onActionRef({ type: "SIDECAR_RESTARTED", cwd: workspace });
        });
        unsubscribePushRef.current = client.onPush((push) => {
            // Workspace-level push (no session dimension) — bypass the
            // per-session processor and deliver directly.
            if (push.method === PushMethods.ModelsChanged) {
                if (push.workspace) onModelsChangedRef(push.workspace);
                return;
            }
            if (push.method === PushMethods.MemoryChanged) {
                if (push.workspace) onMemoryChangedRef(push.workspace);
                return;
            }
            if (push.method === PushMethods.ChannelStatusChanged) {
                // Fanned out per workspace but process-level in meaning; the
                // handler is idempotent on channelId, so extra copies are safe.
                const params = push.params as { channel?: ChannelStatusEntry } | undefined;
                if (params?.channel) onChannelStatusChangedRef(params.channel);
                return;
            }
            if (push.method === PushMethods.ConversationsChanged) {
                // Same workspace-fanned-out shape as the other invalidate
                // pushes; the handler re-pulls channels.listConversations.
                onConversationsChangedRef();
                return;
            }
            if (push.method === PushMethods.WorkChanged) {
                // Process-level: no session dimension, so it must be handled
                // before anything that routes by session. The payload is empty;
                // the pane re-pulls everything.
                onWorkChangedRef();
                return;
            }
            if (push.method === PushMethods.ImPolicyChanged) {
                const params = push.params as { channelId?: string } | undefined;
                if (params?.channelId) onImPolicyChangedRef(params.channelId);
                return;
            }
            if (push.method === PushMethods.ImWorkspacesInvalidated) {
                // Workspace-dimensioned pre-dispose notice (fanned out per live
                // workspace on the channel). The dialog already confirms before
                // saving, so this only feeds a future desktop warning.
                const params = push.params as { channelId?: string } | undefined;
                if (params?.channelId) onImWorkspacesInvalidatedRef(params.channelId);
                return;
            }
            if (push.method === PushMethods.WorkspaceAssociationsChanged) {
                // The affected set moved. The payload names WHICH key changed
                // — a channel-scoped change names the channel, a workspace-
                // scoped one the workspace.
                const params = push.params as { key?: WorkspaceAssociationKey } | undefined;
                if (params?.key) onWorkspaceAssociationsChangedRef(params.key);
                return;
            }
            void processor.process(push).catch(reportFailure);
        });

        let cancelled = false;
        let exitUnlisten: UnlistenFn | undefined;
        const init = async () => {
            // Rust batches stderr lines into one event per ~50ms / 64 lines
            // (`{lines: string[]}` payload) so a single LLM payload's
            // hundreds of folded `[taco:llm]` lines don't drown IPC. The
            // single-line `{line}` payload is kept as a fallback for any
            // out-of-tree emitter.
            const onExitUnlisten = await listen("sidecar-exited", () => invalidate(true));
            if (cancelled) {
                onExitUnlisten();
                return;
            }
            exitUnlisten = onExitUnlisten;
            const unlisten = await listen<{ line?: string; lines?: string[] }>(
                "sidecar-log",
                (event) => {
                    const lines =
                        event.payload.lines ?? (event.payload.line ? [event.payload.line] : []);
                    for (const line of lines) {
                        if (line.startsWith(LLM_DUMP_PREFIX)) {
                            onLlmDumpLineRef(line);
                            continue;
                        }
                        const parsed = parseLogLine(line);
                        const severity = bannerSeverity(parsed);
                        if (severity === "error") onLogLineRef(formatForBanner(parsed));
                        else if (severity === "warn") onWarningLineRef(formatForBanner(parsed));
                    }
                },
            );
            if (cancelled) {
                unlisten();
                return;
            }
            logUnlistenRef.current = unlisten;
            // Fire once. The second render's effect re-enters this branch
            // (the listener is already up) and resolves to a no-op because
            // the module-scope resolver is itself idempotent.
            READY_PROMISE.resolve();
        };
        void init();

        return () => {
            cancelled = true;
            unbindSynchronization();
            invalidate();
            unsubscribeReady();
            exitUnlisten?.();
            unsubscribePushRef.current?.();
            unsubscribePushRef.current = undefined;
            unsubscribeEpoch();
            logUnlistenRef.current?.();
            logUnlistenRef.current = undefined;
        };
    }, [
        client,
        getRecoveryTargets,
        onActionRef,
        onChannelStatusChangedRef,
        onConversationsChangedRef,
        onImPolicyChangedRef,
        onWorkChangedRef,
        onImWorkspacesInvalidatedRef,
        onWorkspaceAssociationsChangedRef,
        onLlmDumpLineRef,
        onLogLineRef,
        onModelsChangedRef,
        onMemoryChangedRef,
        onWarningLineRef,
    ]);

    const clearCursors = useCallback(() => {
        recoveryGenerationRef.current++;
        processorRef.current?.clear();
    }, []);
    return { clearCursors };
}
