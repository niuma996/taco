import type {
    AttachmentStageResult,
    ImageInput,
    SessionTarget,
    ThinkingLevel,
} from "@taco-ai/protocol";
import type { ModelSelection } from "../components/settings/ModelPicker";
import type { StagedAttachment, StageInput } from "../lib/attachments";
import type { ConversationTarget } from "../lib/chat/conversationDrafts";
import type { WorkspaceAction, WorkspaceState } from "../lib/chat/workspaceReducer";
import type { AppNotification, PushNotificationOptions } from "../lib/notifications";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import type { AskUserPayload } from "./useAskUser";
import type { SidecarAction } from "./useSidecarStream";

export interface UseWorkspacesApi {
    // ── state (read-only) ──
    workspaces: Record<string, WorkspaceState>;
    activeCwd: string;
    composerTarget: ConversationTarget;
    submitPrompt: (
        target: ConversationTarget,
        text: string,
        images: ImageInput[] | undefined,
        attachments: StagedAttachment[] | undefined,
        steering?: boolean,
    ) => Promise<"accepted" | "rejected" | "unknown">;
    getComposerTarget: (workspace?: string) => ConversationTarget;
    onDraftCreated: (
        listener: (event: { workspace: string; draftId: string; sessionId: string }) => void,
    ) => () => void;
    onSessionRemoved: (listener: (target: SessionTarget) => void) => () => void;
    activeWs: WorkspaceState | undefined;
    sessionLevels: Record<string, ThinkingLevel>;
    /** Newest first. Backs the topbar notification bell. */
    notifications: AppNotification[];
    /** See `UseWorkspaceLifecycleApi.defaultCwdSettled`. */
    defaultCwdSettled: boolean;

    // ── top-level lifecycle ──
    /** Handle SidecarAction — entry paired with useSidecarStream's onAction. */
    dispatch: (action: SidecarAction) => void;
    /** Dispatch WorkspaceAction directly (for view components to fire non-push actions, e.g. history expand fetch). */
    dispatchWs: (action: WorkspaceAction) => void;
    /**
     * Notification setter (kept out of workspaces reducer — error display is not
     * business state). Defaults to a `client`-sourced error, which is what every
     * caller replying to a user action wants; sidecar-stream callers pass
     * `source: "sidecar"` so the row lands in the bell without a toast. `kind`
     * lets a consumer filter the list; repeats of the same text coalesce.
     */
    pushNotification: (msg: string, opts?: PushNotificationOptions) => void;
    /** Drop one notification by id. */
    dismissNotification: (id: number) => void;
    /** Drop every notification — used by the bell's "clear all". */
    clearNotifications: () => void;

    // ── workspace CRUD ──
    initFromStorage: () => Promise<void>;
    /** Called after sidecar restart: refetch every workspace's sessions and attach the first. */
    reloadAllWorkspaces: () => Promise<void>;
    /** Sidebar "load more" — appends the next page using the current cursor. */
    loadMoreSessions: (cwd: string) => Promise<void>;
    /**
     * Resolve `true` when the workspace was ensured on the sidecar and is
     * now the active one; `false` if validation failed or the load/switch
     * step threw. Errors are already surfaced via toast + the notification bell —
     * the boolean is for callers (e.g. onboarding) that need to gate the next
     * UI step on actual success. The previous fire-and-forget signature is
     * intentionally tightened; the only other caller (`browseAndOpen`)
     * ignores the return value.
     */
    openWorkspace: (rawCwd: string) => Promise<boolean>;
    browseAndOpen: () => Promise<void>;
    switchWorkspace: (cwd: string) => Promise<void>;
    attachSession: (cwd: string, sid: string) => Promise<void>;
    /**
     * Open an IM conversation (a passive im:// cwd the sidecar surfaced via
     * channels.listConversations). Unlike openWorkspace, this does NOT call
     * persistCwds: IM conversations are not user-picked folders, so they
     * must not appear in the next session's "reopen" list or in the topbar
     * WorkspacePicker's project dropdown. It also seeds an empty
     * WorkspaceState via INIT (required because attachSession's ATTACH
     * reducer case is a no-op when no entry exists for the cwd).
     */
    openImConversation: (cwd: string, sid: string, isCurrent?: () => boolean) => Promise<void>;
    /** Rebuild a session after the sidecar's bounded realtime replay window has expired. */
    restoreSessionSnapshot: (
        cwd: string,
        sid: string,
        sessionKind: "main" | "subagent",
        isCurrent?: () => boolean,
    ) => Promise<SnapshotRecovery>;
    deleteSession: (cwd: string, sid: string) => Promise<void>;
    renameSession: (cwd: string, sid: string, name: string) => Promise<void>;

    // ── session lifecycle ──
    /**
     * Clear the current active session + messages without any backend call.
     * The first real send creates the session on the server and pulls the id
     * from the response. Sessions list is preserved so the user can re-attach
     * to a prior chat from the sidebar.
     */
    beginPendingNewSession: (cwd: string) => void;
    /**
     * Send a prompt. Return value signals "did it actually reach the backend":
     *  - true: sent (or new session created with initialPrompt); caller may clear the input.
     *  - false: empty after trim with no attachments / sessionPrompt threw; input should stay.
     *
     * When the server reports `session_busy` (a run is already in flight), this
     * degrades to steerPrompt once — the user's text is delivered as an in-run
     * steer rather than rejected. See STEER_PROMPT_HANDOFF for why the handoff
     * cannot bounce more than once.
     */
    sendPrompt: (
        text: string,
        images?: ImageInput[],
        attachments?: StagedAttachment[],
        target?: ConversationTarget,
    ) => Promise<boolean>;
    /**
     * Enqueue a steer message on the session's active run. Same return contract
     * as sendPrompt. If the server reports the run is already over (`mode:
     * "idle"`), this degrades to sendPrompt once so the text is not lost.
     */
    steerPrompt: (
        text: string,
        images?: ImageInput[],
        attachments?: StagedAttachment[],
        target?: ConversationTarget,
    ) => Promise<boolean>;
    /** Copy/stage a file for the next prompt in the active workspace. */
    stageAttachment: (
        source: StageInput,
        target?: ConversationTarget,
    ) => Promise<AttachmentStageResult>;
    /** Cancel one not-yet-consumed queue entry by server entryId (QueueBar row). */
    cancelQueued: (entryId: string, target?: SessionTarget) => Promise<void>;
    /**
     * Abort the active turn. Resolves to the drained steer/follow-up texts (in
     * drain order) so the caller can restore them into the composer — an
     * interrupted steer is user input, not garbage. Empty array when nothing
     * was queued or the abort did not apply.
     */
    abortPrompt: (target?: SessionTarget) => Promise<string[]>;

    // ── thinking level ──
    setSessionLevel: (next: ThinkingLevel) => Promise<void>;
    /** Thinking level displayed for the current session. */
    activeLevel: ThinkingLevel | null;

    // ── model ──
    setSessionModel: (next: ModelSelection) => Promise<void>;
    /** Model displayed for the current session; null if no override and still loading. */
    activeModel: ModelSelection | null;

    // ── subagent ──
    /**
     * Lazily load a child session's history (called when user first expands the agent card).
     * Writes to `childHistoryLoaded[subSessionId]` via reducer; UI renders immediately.
     */
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Stop one running subagent (subagent.abort) without aborting the session's
     * turn. The settled outcome arrives through the normal paths (tool_end for a
     * sync child, SUBAGENT_SETTLED with outcome "aborted" for a background one).
     */
    abortSubagent: (subSessionId: string) => Promise<void>;

    /** Stage askUser answers and metadata for an explicit target-captured submission. */
    setAskUserAnswers: (
        toolCallId: string,
        payload: AskUserPayload,
        target?: SessionTarget,
    ) => void;
}
