/**
 * useWorkspaces — workspace / session state machine, persistence, and CRUD.
 *
 * Domain state lives in the workspaces reducer; per-session thinking level and
 * model are delegated to useSessionSettings. notifications is a plain useState,
 * kept out of the reducer so error display does not pollute business state.
 * Drafts are owned by useConversationDrafts; modal state stays in App.
 */

import type { ImageInput, SessionTarget, SupportedLocale } from "@taco-ai/protocol";
import {
    asSessionId,
    asToolCallId,
    asWorkspaceId,
    ErrorCodes,
    IM_CWD_PREFIX,
} from "@taco-ai/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useT } from "../i18n/useI18n";
import type { StagedAttachment, StageInput } from "../lib/attachments";
import { toMessageAttachments } from "../lib/attachments";
import { historyToUiMessages, type QueuedUiItem, type UiMessage } from "../lib/chat/chatUtils";
import type { ConversationTarget } from "../lib/chat/conversationDrafts";
import {
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../lib/chat/workspaceReducer";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { getGlobalConfig } from "../lib/globalConfig";
import type { AppNotification, PushNotificationOptions } from "../lib/notifications";
import type { AskUserPayload } from "./useAskUser";
import { useSessionSettings } from "./useSessionSettings";
import type { SidecarAction } from "./useSidecarStream";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";
import type { UseWorkspacesApi } from "./workspacesTypes";

export type { SessionMeta, WorkspaceState } from "../lib/chat/workspaceReducer";

// ─────────────────────────────────────────────────────────────────────
// useWorkspaces
// ─────────────────────────────────────────────────────────────────────

export type { UseWorkspacesApi } from "./workspacesTypes";

/**
 * Whether a send may still hand off to the other delivery path.
 *
 * sendPrompt and steerPrompt each degrade into the other: a prompt rejected with
 * `session_busy` becomes a steer, and a steer that reports `idle` becomes a
 * prompt. Both conditions are real server states rather than stale reads, so a
 * session whose runs start and stop quickly (a queue draining, say) can flip
 * between them repeatedly — nothing about the handoff converges on its own.
 * The first hop passes "exhausted" so the second cannot hop again; it surfaces
 * an error the user can retry instead.
 */
type SteerHandoff = "allowed" | "exhausted";
interface SubmissionState {
    unknown: boolean;
}

/** A chatty sidecar must not grow the list without bound; the oldest fall off. */
const MAX_NOTIFICATIONS = 50;
/**
 * Identical text arriving within this window merges into the head row instead of
 * appending a new one. The old error banner showed only the latest message, so
 * without this a per-tick `[error]` line would fill the whole list with copies.
 */
const COALESCE_WINDOW_MS = 10_000;

export function useWorkspaces(client: TacoClient): UseWorkspacesApi {
    const { t } = useT();
    const [workspaces, dispatchReducer] = useReducer(workspacesReducer, {});
    // Active cwd is read from desktop.json (via the IPC) inside initFromStorage;
    // the lazy initializer can only return a synchronous value, so we seed with
    // the empty string and let initFromStorage set the real value once the
    // read resolves. The first paint uses the empty placeholder; initFromStorage
    // runs in a mount effect so React commits the real value before the user
    // can interact with the workspace selector.
    const [activeCwd, setActiveCwd] = useState<string>("");
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    // Per-instance id source. A module-level counter would be shared by every
    // mounted hook (and survive HMR), so two lists could hand out the same id.
    const notificationSeqRef = useRef(0);
    const pushNotification = useCallback((text: string, opts: PushNotificationOptions = {}) => {
        const { kind = "generic", source = "client", level = "error" } = opts;
        const at = Date.now();
        // Allocated eagerly so the state updater stays pure — React may invoke
        // it more than once per dispatch (StrictMode double-render).
        notificationSeqRef.current += 1;
        const id = notificationSeqRef.current;
        setNotifications((prev) => {
            const head = prev[0];
            if (
                head &&
                head.text === text &&
                head.approval?.requestId === opts.approval?.requestId &&
                head.kind === kind &&
                head.source === source &&
                head.level === level &&
                at - head.at < COALESCE_WINDOW_MS
            ) {
                // Same message, still repeating: bump the head row instead of
                // appending a duplicate. `at` moves so the row's clock reads as
                // "still happening", and a stream that keeps repeating stays one
                // row for as long as it does. The id is kept, so the bell treats
                // a repeat as the row it already announced, not a new arrival.
                return [{ ...head, at, count: head.count + 1 }, ...prev.slice(1)];
            }
            const entry: AppNotification = {
                id,
                text,
                at,
                count: 1,
                kind,
                source,
                level,
                ...(opts.approval ? { approval: opts.approval } : {}),
            };
            return [entry, ...prev].slice(0, MAX_NOTIFICATIONS);
        });
    }, []);
    const dismissNotification = useCallback((id: number) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);
    const clearNotifications = useCallback(() => setNotifications([]), []);

    // workspacesRef — for read-after-write paths (attachSession / switchWorkspace, etc.).
    const workspacesRef = useRef<Record<string, WorkspaceState>>(workspaces);
    const selectedTargetsRef = useRef(new Map<string, ConversationTarget>());
    const pendingCreatesRef = useRef(new Map<string, symbol>());
    const createdDraftsRef = useRef(new Map<string, string>());
    const draftCreatedListeners = useRef(
        new Set<(event: { workspace: string; draftId: string; sessionId: string }) => void>(),
    );
    const sessionRemovedListeners = useRef(new Set<(target: SessionTarget) => void>());
    const navigationVersion = useRef(0);
    const runEpochs = useRef(new Map<string, number>());
    const promptTokens = useRef(new Map<string, symbol>());
    const activeCwdRef = useRef(activeCwd);
    activeCwdRef.current = activeCwd;
    const getNavigationVersion = useCallback(() => navigationVersion.current, []);
    const selectWorkspace = useCallback((cwd: string) => {
        activeCwdRef.current = cwd;
        setActiveCwd(cwd);
    }, []);
    const onDraftCreated = useCallback(
        (listener: (event: { workspace: string; draftId: string; sessionId: string }) => void) => {
            draftCreatedListeners.current.add(listener);
            return () => {
                draftCreatedListeners.current.delete(listener);
            };
        },
        [],
    );
    const onSessionRemoved = useCallback((listener: (target: SessionTarget) => void) => {
        sessionRemovedListeners.current.add(listener);
        return () => {
            sessionRemovedListeners.current.delete(listener);
        };
    }, []);

    function captureComposerTarget(
        workspace = activeCwdRef.current,
        state = workspacesRef.current,
    ): ConversationTarget {
        const selected = selectedTargetsRef.current.get(workspace);
        const sid = state[workspace]?.activeSession;
        if (selected && (selected.kind === "session" || !sid)) return selected;
        if (sid) return { kind: "session", workspace, sessionId: sid };
        const target: ConversationTarget = {
            kind: "draft",
            workspace,
            draftId: state[workspace]?.draftId ?? crypto.randomUUID(),
        };
        selectedTargetsRef.current.set(workspace, target);
        return target;
    }
    const capturedTarget = captureComposerTarget(activeCwd, workspaces);
    const { kind, workspace } = capturedTarget;
    const targetId = kind === "session" ? capturedTarget.sessionId : capturedTarget.draftId;
    const composerTarget = useMemo<ConversationTarget>(
        () =>
            kind === "session"
                ? { kind, workspace, sessionId: targetId }
                : { kind, workspace, draftId: targetId },
        [kind, workspace, targetId],
    );
    // Stop-triggered prompt rejection is expected. Scope suppression to the
    // workspace/session so navigation cannot hide another session's failure.
    const abortRequestedRef = useRef<Set<string>>(new Set());
    const dispatchWs = useCallback((action: WorkspaceAction) => {
        if (action.type === "REMOVE_SESSION") {
            const key = JSON.stringify([action.cwd, action.sid]);
            runEpochs.current.delete(key);
            promptTokens.current.delete(key);
            abortRequestedRef.current.delete(key);
            const selected = selectedTargetsRef.current.get(action.cwd);
            if (selected?.kind === "session" && selected.sessionId === action.sid)
                selectedTargetsRef.current.delete(action.cwd);
        }
        dispatchReducer(action);
        if (action.type === "REMOVE_SESSION")
            for (const listener of sessionRemovedListeners.current)
                listener({ workspace: action.cwd, sessionId: action.sid });
    }, []);
    useEffect(() => {
        workspacesRef.current = workspaces;
        for (const [cwd, target] of selectedTargetsRef.current) {
            if (
                workspaces[cwd]?.activeSession &&
                (target.kind === "draft" || workspaces[cwd]?.activeSession === target.sessionId)
            )
                selectedTargetsRef.current.delete(cwd);
        }
    }, [workspaces]);

    const settings = useSessionSettings({
        client,
        activeCwd,
        activeSession: workspaces[activeCwd]?.activeSession,
        activeDraftId: composerTarget.kind === "draft" ? composerTarget.draftId : undefined,
        pushNotification,
    });
    // sendPrompt's lazy-create branch awaits sessionCreate before recording the
    // new session's level/model, so it must read the settings API as of
    // await-resolution time rather than through its render-time closure.
    const settingsRef = useRef(settings);
    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    // ── workspace CRUD / lifecycle ──
    const lifecycle = useWorkspaceLifecycle({
        client,
        dispatchWs,
        workspacesRef,
        activeCwd,
        getNavigationVersion,
        setActiveCwd: selectWorkspace,
        pushNotification,
    });
    const { refreshSessionList, attachSessionRef } = lifecycle;

    // Payloads and in-flight submissions share the rendered workspace/session/tool identity.
    const askUserAnswersRef = useRef(new Map<string, AskUserPayload>());
    const submittingAnswersRef = useRef(new Set<string>());
    const answerKey = useCallback(
        (cwd: string, sid: string, toolCallId: string) => JSON.stringify([cwd, sid, toolCallId]),
        [],
    );

    const permissionRequestsRef = useRef(
        new Map<string, { seen: Set<string>; retired: Set<string> }>(),
    );
    const permissionRequests = useCallback((cwd: string) => {
        let entry = permissionRequestsRef.current.get(cwd);
        if (!entry) {
            entry = { seen: new Set(), retired: new Set() };
            permissionRequestsRef.current.set(cwd, entry);
        }
        return entry;
    }, []);

    const activeWs = workspaces[activeCwd];

    // ── helpers ──
    const dispatch = useCallback(
        (action: SidecarAction) => {
            if (action.type === "SET_SESSION_SYNC" || action.type === "SESSION_UNCERTAIN") {
                if (action.type === "SESSION_UNCERTAIN")
                    promptTokens.current.delete(JSON.stringify([action.cwd, action.sid]));
                dispatchWs(action);
            } else if (action.type === "REMOVE_SESSION") {
                dispatchWs(action);
            } else if (action.type === "EVENT") {
                if (action.ev.type === "run_start") {
                    const key = JSON.stringify([action.cwd, action.sid]);
                    runEpochs.current.set(key, (runEpochs.current.get(key) ?? 0) + 1);
                }
                dispatchWs({
                    type: "APPLY_EVENT",
                    cwd: action.cwd,
                    sid: action.sid,
                    suppressedThinking: settings.isThinkingSuppressed(action.sid, action.cwd),
                    now: Date.now(),
                    ev: action.ev,
                });
            } else if (action.type === "CHILD_MESSAGE_EVENT") {
                // Child session realtime events — the child harness doesn't expose a thinking
                // level config, treat as enabled (not suppressed), matching parent default.
                dispatchWs({
                    type: "CHILD_MESSAGE_EVENT",
                    cwd: action.cwd,
                    subSessionId: action.sid,
                    suppressedThinking: false,
                    now: Date.now(),
                    ev: action.ev,
                });
            } else if (action.type === "SUBAGENT_SPAWNED") {
                dispatchWs({
                    type: "SUBAGENT_SPAWNED",
                    cwd: action.cwd,
                    parentSessionId: action.parentSessionId,
                    parentToolCallId: action.parentToolCallId,
                    subSessionId: action.subSessionId,
                    agentType: action.agentType,
                });
            } else if (action.type === "SUBAGENT_SETTLED") {
                dispatchWs({
                    type: "SUBAGENT_SETTLED",
                    cwd: action.cwd,
                    parentSessionId: action.parentSessionId,
                    parentToolCallId: action.parentToolCallId,
                    outcome: action.outcome,
                });
            } else if (action.type === "ATTACHED") {
                dispatchWs({ type: "ATTACHED_PUSH", cwd: action.cwd, sid: action.sid });
            } else if (action.type === "COMMAND_PERMISSION_REQUESTED") {
                const requests = permissionRequests(action.cwd);
                if (requests.retired.has(action.request.requestId)) return;
                requests.seen.add(action.request.requestId);
                if (
                    action.cwd.startsWith(IM_CWD_PREFIX) &&
                    !workspacesRef.current[action.cwd]?.pendingCommandPermissions[
                        action.request.requestId
                    ]
                ) {
                    pushNotification(t("session.imApprovalRequired"), {
                        source: "sidecar",
                        level: "warn",
                        approval: {
                            cwd: action.cwd,
                            sessionId: action.request.displaySessionId ?? action.sid,
                            requestId: action.request.requestId,
                        },
                    });
                }
                dispatchWs({
                    type: "COMMAND_PERMISSION_REQUESTED",
                    cwd: action.cwd,
                    sid: action.sid,
                    request: action.request,
                });
            } else if (action.type === "COMMAND_PERMISSION_RESOLVED") {
                permissionRequests(action.cwd).seen.delete(action.requestId);
                setNotifications((prev) =>
                    prev.filter((n) => n.approval?.requestId !== action.requestId),
                );
                dispatchWs({
                    type: "COMMAND_PERMISSION_RESOLVED",
                    cwd: action.cwd,
                    requestId: action.requestId,
                });
            } else if (action.type === "SIDECAR_RESTARTED") {
                for (const key of promptTokens.current.keys())
                    if ((JSON.parse(key) as string[])[0] === action.cwd)
                        promptTokens.current.delete(key);
                const requests = permissionRequests(action.cwd);
                requests.retired.clear();
                for (const id of requests.seen) requests.retired.add(id);
                for (const id of Object.keys(
                    workspacesRef.current[action.cwd]?.pendingCommandPermissions ?? {},
                )) {
                    requests.retired.add(id);
                }
                requests.seen.clear();
                setNotifications((prev) => prev.filter((n) => n.approval?.cwd !== action.cwd));
                dispatchWs({ type: "SIDECAR_RESTARTED", cwd: action.cwd });
                // The replacement daemon starts with no attached sessions —
                // re-attach the active one so per-session RPCs (setModel,
                // setLevel, prompt) work again. Fires after the new daemon's
                // initialize handshake, so the attach lands on a serving
                // process. Without this, optimistic UI updates roll back on
                // the first "session not attached" error.
                const sid = workspacesRef.current[action.cwd]?.activeSession;
                if (sid) {
                    void attachSessionRef.current(action.cwd, sid).catch((err: unknown) => {
                        console.error(
                            "[taco] re-attach after sidecar restart failed",
                            action.cwd,
                            err,
                        );
                    });
                }
            } else if (action.type === "ERROR") {
                // A `session.error` push — the sidecar's own report, not the
                // reply to a click, so it goes to the bell without a toast.
                pushNotification(action.message, { source: "sidecar" });
                if (action.cwd && action.sid) {
                    const sysMsg: UiMessage = {
                        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        kind: "system",
                        text: action.message,
                        ts: Date.now(),
                    };
                    dispatchWs({
                        type: "APPEND_SYSTEM",
                        cwd: action.cwd,
                        sid: action.sid,
                        msg: sysMsg,
                    });
                }
            } else if (action.type === "ASKUSER_ANSWERED") {
                const { cwd, sid, toolCallId, answers } = action;
                const key = answerKey(cwd, sid, toolCallId);
                if (submittingAnswersRef.current.has(key)) return;
                const payload = askUserAnswersRef.current.get(key);
                submittingAnswersRef.current.add(key);
                void client
                    .sessionSubmitAnswers({
                        workspace: asWorkspaceId(cwd),
                        sessionId: asSessionId(sid),
                        toolCallId: asToolCallId(toolCallId),
                        answers,
                        toolName: payload?.toolName ?? "askUser",
                    })
                    .then(() => {
                        dispatchWs({ type: "ASKUSER_ANSWERED", cwd, sid, toolCallId, answers });
                        askUserAnswersRef.current.delete(key);
                    })
                    .catch((err: unknown) => {
                        pushNotification(
                            t("session.submitAnswersFailed", { error: (err as Error).message }),
                        );
                    })
                    .finally(() => {
                        submittingAnswersRef.current.delete(key);
                    });
            } else if (action.type === "TASKS_UPDATED") {
                // Sidecar pushes the latest list snapshot on every successful task-tool path
                // (tasks.updated push). Drives TaskPanel realtime refresh.
                dispatchWs({
                    type: "TASKS_UPDATED",
                    cwd: action.cwd,
                    sid: action.sid,
                    active: action.active,
                    history: action.history,
                });
            } else if (action.type === "PLAN_STATE_UPDATED") {
                dispatchWs({
                    type: "PLAN_STATE_UPDATED",
                    cwd: action.cwd,
                    sid: action.sid,
                    active: action.active,
                    currentSlug: action.currentSlug,
                });
            } else if (action.type === "SESSION_RENAMED") {
                dispatchWs({
                    type: "SESSION_RENAMED",
                    cwd: action.cwd,
                    sid: action.sid,
                    name: action.name,
                });
            }
        },
        // attachSessionRef is a stable ref object; its .current is read at call
        // time on purpose, so it must not be a dependency.
        [
            client,
            settings,
            attachSessionRef,
            pushNotification,
            t,
            answerKey,
            permissionRequests,
            dispatchWs,
        ],
    );

    const beginPendingNewSession = useCallback(
        (cwd: string): void => {
            navigationVersion.current++;
            const draftId = crypto.randomUUID();
            selectedTargetsRef.current.set(cwd, { kind: "draft", workspace: cwd, draftId });
            dispatchWs({ type: "BEGIN_PENDING_NEW_SESSION", cwd, draftId });
        },
        [dispatchWs],
    );

    function sendPrompt(
        text: string,
        images?: ImageInput[],
        attachments?: StagedAttachment[],
        target = captureComposerTarget(),
    ): Promise<boolean> {
        return sendToTarget(target, text, images, attachments, "allowed");
    }

    async function sendToTarget(
        target: ConversationTarget,
        text: string,
        images: ImageInput[] | undefined,
        attachments: StagedAttachment[] | undefined,
        handoff: SteerHandoff,
        submission?: SubmissionState,
    ): Promise<boolean> {
        const trimmed = text.trim();
        if (!trimmed && !images?.length && !attachments?.length) return false;
        const cwd = target.workspace;
        const uiLocale = getGlobalConfig().client.uiLanguage;
        if (target.kind === "session")
            return deliverPrompt(
                cwd,
                target.sessionId,
                text,
                trimmed,
                images,
                attachments,
                uiLocale,
                handoff,
                undefined,
                submission,
            );
        const key = JSON.stringify([cwd, target.draftId]);
        const existing = createdDraftsRef.current.get(key);
        if (existing)
            return deliverPrompt(
                cwd,
                existing,
                text,
                trimmed,
                images,
                attachments,
                uiLocale,
                handoff,
                undefined,
                submission,
            );
        if (pendingCreatesRef.current.has(key)) return false;
        const token = Symbol("create");
        pendingCreatesRef.current.set(key, token);
        const defaults = settingsRef.current.newSessionDefaults(target);
        let sid: string;
        try {
            const created = await client.sessionCreate({
                workspace: asWorkspaceId(cwd),
                thinkingLevel: defaults.initialLevel,
            });
            sid = created.sessionId;
            createdDraftsRef.current.set(key, sid);
            settingsRef.current.adoptNewSession(sid, defaults, target);
            const selected = selectedTargetsRef.current.get(cwd);
            const makeActive = selected?.kind === "draft" && selected.draftId === target.draftId;
            if (makeActive)
                selectedTargetsRef.current.set(cwd, {
                    kind: "session",
                    workspace: cwd,
                    sessionId: sid,
                });
            dispatchWs({
                type: "ADD_SESSION",
                cwd,
                session: {
                    id: sid,
                    createdAt: new Date().toISOString(),
                    filePath: created.filePath,
                },
                makeActive,
            });
            for (const listener of draftCreatedListeners.current)
                listener({ workspace: cwd, draftId: target.draftId, sessionId: sid });
            dispatchWs({
                type: "APPEND_USER",
                cwd,
                sid,
                msg: {
                    id: `optimistic-user-${crypto.randomUUID()}`,
                    kind: "user",
                    text: trimmed,
                    ts: Date.now(),
                    ...(images?.length ? { images } : {}),
                    ...(attachments?.length
                        ? { attachments: toMessageAttachments(attachments) }
                        : {}),
                },
            });
        } catch (error) {
            pushNotification(`Prompt failed: ${(error as Error).message}`);
            if (submission && !(error as { code?: string }).code) submission.unknown = true;
            return false;
        } finally {
            if (pendingCreatesRef.current.get(key) === token) pendingCreatesRef.current.delete(key);
        }
        return deliverPrompt(
            cwd,
            sid,
            text,
            trimmed,
            images,
            attachments,
            uiLocale,
            handoff,
            defaults.initialModel ?? undefined,
            submission,
        );
    }

    /**
     * Deliver one prompt to a session that already exists on the server and
     * settle the UI around the outcome. Shared by the first message of a new
     * session and every later one: a failed turn never deletes the session,
     * because by the time `session.prompt` fails the user's message is already
     * on disk. Removing a session is the user's call (`deleteSession`), not a
     * side effect of a turn ending badly — a Stop click rejects this RPC too.
     */
    async function deliverPrompt(
        cwd: string,
        promptSid: string,
        text: string,
        trimmed: string,
        images: ImageInput[] | undefined,
        attachments: StagedAttachment[] | undefined,
        uiLocale: SupportedLocale | undefined,
        handoff: SteerHandoff,
        model?: { provider: string; id: string },
        submission?: SubmissionState,
    ): Promise<boolean> {
        const requestKey = JSON.stringify([cwd, promptSid]);
        const requestToken = Symbol("prompt");
        const expectedRun = (runEpochs.current.get(requestKey) ?? 0) + 1;
        promptTokens.current.set(requestKey, requestToken);
        const ownsExecution = () =>
            promptTokens.current.get(requestKey) === requestToken &&
            (runEpochs.current.get(requestKey) ?? 0) <= expectedRun;
        const settlePending = () => {
            if (ownsExecution())
                dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
        };
        // Immediate UI feedback: move the current session to top before the
        // server turn completes. The real updatedAt will be overwritten by the
        // subsequent refreshSessionList once the turn ends.
        dispatchWs({
            type: "BUMP_SESSION_TIME",
            cwd,
            sid: promptSid,
            updatedAt: new Date().toISOString(),
        });
        dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: true });
        try {
            const reply = (
                await client.sessionPrompt({
                    workspace: asWorkspaceId(cwd),
                    sessionId: asSessionId(promptSid),
                    text: trimmed,
                    images,
                    uiLocale,
                    model,
                    attachments: attachments?.map((a) => a.id),
                })
            ).assistantMessage;
            // Auto-title is persisted inside server-side session.prompt and invalidateListCache'd,
            // so refreshing this workspace's session list now must read the latest name. List-only
            // refresh, no attach — using reloadAllWorkspaces would force-attach sessions[0] and swap
            // the user's in-conversation history panel to the newest session (dropping this turn's
            // reply). Refreshing after sessionPrompt returns avoids racing the server's title write
            // (a concurrent fire could read a stale title).
            void refreshSessionList(cwd);
            // The turn completed, so no abort-induced rejection is coming for it.
            // Dropping the marker here is what keeps it from outliving this turn:
            // an abort that lands just as the run finishes resolves the RPC
            // instead of rejecting it, and a marker left behind would swallow the
            // notification for this session's next genuine prompt failure.
            abortRequestedRef.current.delete(JSON.stringify([cwd, promptSid]));
            if (reply) {
                dispatchWs({
                    type: "APPEND_ASSISTANT_FINAL",
                    cwd,
                    sid: promptSid,
                    reply,
                    preserveExecution: !ownsExecution(),
                });
                // Clear pending for the source session even when it is not active.
                // APPEND_ASSISTANT_FINAL skips non-active sessions (messages unchanged),
                // so we must dispatch SET_PENDING here to unblock the send/stop button.
                settlePending();
            } else {
                settlePending();
            }
            return true;
        } catch (err) {
            console.error("[taco] sessionPrompt failed", err);
            // User-initiated abort rejects the in-flight prompt RPC — that is
            // the expected Stop outcome, not a failure to report. (Checked
            // first: a session_busy from a concurrent turn should not consume
            // the marker.)
            if (abortRequestedRef.current.delete(JSON.stringify([cwd, promptSid]))) {
                settlePending();
                return false;
            }
            // session_busy = the server has a run in flight for this session. The
            // turn-start failed, but the text can still land as an in-run steer —
            // degrade instead of surfacing an error the user can't act on. Only
            // once: see SteerHandoff.
            // Pending deliberately stays set: session_busy means a run really is
            // in flight, and its run_end is what clears the slot.
            if ((err as { code?: string }).code === ErrorCodes.SessionBusy) {
                if (handoff === "allowed") {
                    return steerToTarget(
                        { workspace: cwd, sessionId: promptSid },
                        text,
                        images,
                        attachments,
                        "exhausted",
                        submission,
                    );
                }
                pushNotification("Prompt failed: the session is busy; try again");
                return false;
            }
            pushNotification(`Prompt failed: ${(err as Error).message}`);
            if (submission && !(err as { code?: string }).code) {
                submission.unknown = true;
                if (!ownsExecution()) return false;
                dispatchWs({
                    type: "SET_SESSION_EXECUTION",
                    cwd,
                    sid: promptSid,
                    execution: "unknown",
                });
                dispatchWs({ type: "SET_SESSION_SYNC", cwd, sid: promptSid, sync: "incomplete" });
            } else settlePending();
            return false;
        } finally {
            if (promptTokens.current.get(requestKey) === requestToken)
                promptTokens.current.delete(requestKey);
        }
    }

    function steerPrompt(
        text: string,
        images?: ImageInput[],
        attachments?: StagedAttachment[],
        target = captureComposerTarget(),
    ): Promise<boolean> {
        if (target.kind === "draft")
            return sendToTarget(target, text, images, attachments, "allowed");
        return steerToTarget(target, text, images, attachments, "allowed");
    }

    async function steerToTarget(
        target: SessionTarget,
        text: string,
        images: ImageInput[] | undefined,
        attachments: StagedAttachment[] | undefined,
        handoff: SteerHandoff,
        submission?: SubmissionState,
    ): Promise<boolean> {
        const trimmed = text.trim();
        if (!trimmed && !images?.length && !attachments?.length) return false;
        const cwd = target.workspace;
        const steerSid = target.sessionId;
        const runKey = JSON.stringify([cwd, steerSid]);
        const runEpoch = runEpochs.current.get(runKey);
        const promptToken = promptTokens.current.get(runKey);
        const uiLocale = getGlobalConfig().client.uiLanguage;
        // A queued row only — deliberately no optimistic user bubble. A queued
        // message is not yet part of the conversation: pi writes it to the lane
        // inbox and may never consume it (the user aborts, or cancels the row),
        // in which case a bubble would claim the message was sent when it never
        // reached the model. The server's message_end push adds the bubble at
        // the moment the run actually consumes the entry.
        const queuedItem: QueuedUiItem = {
            id: `optimistic-queued-${Date.now()}`,
            kind: "steer",
            text: trimmed,
            optimistic: true,
        };
        dispatchWs({ type: "APPEND_QUEUED", cwd, sid: steerSid, item: queuedItem });
        try {
            const result = await client.sessionSteer({
                workspace: asWorkspaceId(cwd),
                sessionId: asSessionId(steerSid),
                text: trimmed,
                images,
                uiLocale,
                attachments: attachments?.map((a) => a.id),
            });
            if (result.mode !== "idle") return true;
            // The run ended between the composer's steer and the server's check,
            // so the entry would sit unconsumed until the next prompt. Hand back
            // to the prompt path — but only once, see SteerHandoff.
            if (handoff === "exhausted") {
                pushNotification("Steer failed: the session stopped accepting input; try again");
                return false;
            }
            return deliverPrompt(
                cwd,
                steerSid,
                text,
                trimmed,
                images,
                attachments,
                uiLocale,
                "exhausted",
                undefined,
                submission,
            );
        } catch (err) {
            console.error("[taco] sessionSteer failed", err);
            pushNotification(`Steer failed: ${(err as Error).message}`);
            if (submission && !(err as { code?: string }).code) {
                submission.unknown = true;
                if (
                    runEpochs.current.get(runKey) !== runEpoch ||
                    promptTokens.current.get(runKey) !== promptToken
                )
                    return false;
                dispatchWs({
                    type: "SET_SESSION_EXECUTION",
                    cwd,
                    sid: steerSid,
                    execution: "unknown",
                });
                dispatchWs({ type: "SET_SESSION_SYNC", cwd, sid: steerSid, sync: "incomplete" });
            }
            return false;
        } finally {
            // The optimistic row's job ends when the RPC settles: on success the
            // server's queue_update has already delivered the real row (pi emits
            // it from inside the lane command, before this response), and on
            // failure there is nothing to show.
            dispatchWs({ type: "REMOVE_QUEUED", cwd, sid: steerSid, id: queuedItem.id });
        }
    }

    async function cancelQueued(entryId: string, target?: SessionTarget): Promise<void> {
        const cwd = target?.workspace ?? activeCwdRef.current;
        const ws = workspacesRef.current[cwd];
        const sid = target?.sessionId ?? ws?.activeSession;
        if (!sid) return;
        // Optimistic removal; the server's queue_update is the authority and
        // re-adds the row if the entry turned out to be already consumed. Capture
        // the row first so a failed RPC can restore it.
        const item = (ws?.queuedBySessionId[sid] ?? []).find((q) => q.id === entryId);
        dispatchWs({ type: "REMOVE_QUEUED", cwd, sid, id: entryId });
        try {
            await client.sessionCancelQueued({
                workspace: asWorkspaceId(cwd),
                sessionId: asSessionId(sid),
                entryId,
            });
        } catch (err) {
            console.error("[taco] sessionCancelQueued failed", err);
            pushNotification(`Cancel failed: ${(err as Error).message}`);
            if (item) dispatchWs({ type: "APPEND_QUEUED", cwd, sid, item });
        }
    }

    async function abortPrompt(target?: SessionTarget): Promise<string[]> {
        const cwd = target?.workspace ?? activeCwdRef.current;
        const ws = workspacesRef.current[cwd];
        const sid = target?.sessionId ?? ws?.activeSession;
        if (!sid) return [];
        const key = JSON.stringify([cwd, sid]);
        const runEpoch = runEpochs.current.get(key);
        // Mark before the RPC: the in-flight sessionPrompt's rejection can land
        // before sessionAbort resolves, and sendPrompt's catch must already know
        // this abort was user-initiated.
        abortRequestedRef.current.add(key);
        try {
            const result = await client.sessionAbort({
                workspace: asWorkspaceId(cwd),
                sessionId: asSessionId(sid),
            });
            if (runEpochs.current.get(key) === runEpoch)
                dispatchWs({ type: "SET_PENDING", cwd, sid, pending: false });
            // Discard order isn't preserved across the two queues server-side;
            // steer went in first and reads more naturally restored first.
            return [...(result.discardedSteer ?? []), ...(result.discardedFollowUp ?? [])];
        } catch (err) {
            console.error("[taco] sessionAbort failed", err);
            // The abort never landed, so no abort-induced prompt rejection is
            // coming — drop the marker or a later genuine failure would be
            // misclassified as user-initiated.
            abortRequestedRef.current.delete(key);
            pushNotification(`Abort failed: ${(err as Error).message}`);
            return [];
        }
    }

    async function loadSubagentHistory(subSessionId: string): Promise<void> {
        const cwd = activeCwd;
        try {
            const hist = await client.sessionHistory({
                workspace: asWorkspaceId(cwd),
                sessionId: asSessionId(subSessionId),
            });
            const msgs = historyToUiMessages(
                hist.entries as Parameters<typeof historyToUiMessages>[0],
            );
            dispatchWs({ type: "LOAD_SUBAGENT_HISTORY", cwd, subSessionId, messages: msgs });
        } catch (err) {
            console.error("[taco] subagent history pull failed", subSessionId, err);
            pushNotification(`Subagent history failed: ${(err as Error).message}`);
        }
    }

    async function abortSubagent(subSessionId: string): Promise<void> {
        try {
            // "not_running" needs no surface: the child already settled, and
            // its terminal state renders through the normal paths.
            await client.subagentAbort({
                workspace: asWorkspaceId(activeCwd),
                subSessionId: asSessionId(subSessionId),
            });
        } catch (err) {
            console.error("[taco] subagentAbort failed", subSessionId, err);
            pushNotification(`Stop subagent failed: ${(err as Error).message}`);
        }
    }

    /** Stage a file against the active workspace; the id goes back with the prompt. */
    async function stageAttachment(source: StageInput, target = captureComposerTarget()) {
        return client.attachmentStage({ workspace: asWorkspaceId(target.workspace), ...source });
    }

    return {
        workspaces,
        activeCwd,
        activeWs,
        composerTarget,
        submitPrompt: async (target, text, images, attachments, steering = false) => {
            const submission = { unknown: false };
            const accepted =
                steering && target.kind === "session"
                    ? await steerToTarget(target, text, images, attachments, "allowed", submission)
                    : await sendToTarget(target, text, images, attachments, "allowed", submission);
            return accepted ? "accepted" : submission.unknown ? "unknown" : "rejected";
        },
        getComposerTarget: captureComposerTarget,
        onDraftCreated,
        onSessionRemoved,
        sessionLevels: settings.sessionLevels,
        notifications,
        defaultCwdSettled: lifecycle.defaultCwdSettled,
        dispatch,
        dispatchWs,
        pushNotification,
        dismissNotification,
        clearNotifications,
        initFromStorage: lifecycle.initFromStorage,
        reloadAllWorkspaces: lifecycle.reloadAllWorkspaces,
        loadMoreSessions: lifecycle.loadMoreSessions,
        openWorkspace: (cwd) => {
            navigationVersion.current++;
            return lifecycle.openWorkspace(cwd);
        },
        browseAndOpen: lifecycle.browseAndOpen,
        openImConversation: (cwd, sid, isCurrent) => {
            navigationVersion.current++;
            selectedTargetsRef.current.set(cwd, {
                kind: "session",
                workspace: cwd,
                sessionId: sid,
            });
            return lifecycle.openImConversation(cwd, sid, isCurrent);
        },
        switchWorkspace: (cwd) => {
            navigationVersion.current++;
            return lifecycle.switchWorkspace(cwd);
        },
        attachSession: async (cwd, sid) => {
            const version = ++navigationVersion.current;
            const target: ConversationTarget = { kind: "session", workspace: cwd, sessionId: sid };
            selectedTargetsRef.current.set(cwd, target);
            try {
                await lifecycle.attachSession(cwd, sid);
            } finally {
                if (
                    version === navigationVersion.current &&
                    selectedTargetsRef.current.get(cwd) === target
                )
                    selectedTargetsRef.current.delete(cwd);
            }
        },
        restoreSessionSnapshot: lifecycle.restoreSessionSnapshot,
        deleteSession: lifecycle.deleteSession,
        renameSession: lifecycle.renameSession,
        beginPendingNewSession,
        sendPrompt,
        steerPrompt,
        stageAttachment,
        cancelQueued,
        abortPrompt,
        setSessionModel: settings.setSessionModel,
        setSessionLevel: settings.setSessionLevel,
        activeModel: settings.activeModel,
        activeLevel: settings.activeLevel,
        loadSubagentHistory,
        abortSubagent,
        setAskUserAnswers: (toolCallId, payload, target) => {
            const cwd = target?.workspace ?? activeCwd;
            const sid = target?.sessionId ?? workspacesRef.current[cwd]?.activeSession;
            if (sid) askUserAnswersRef.current.set(answerKey(cwd, sid, toolCallId), payload);
        },
    };
}
