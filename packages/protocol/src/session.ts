/**
 * session.* RPC params/result types — lifecycle (create/attach/detach/delete),
 * turn (prompt/steer/abort), runtime (setModel/setThinkingLevel/compact/
 * contextInfo), and snapshot/history reads. Depends on frames for routing
 * keys and push for TasksUpdatedParams/PlanStateUpdatedParams shape.
 */

import type { CustomProviderApi } from "./config.js";
import type {
    CompactionFailureReason,
    ImageInput,
    ServerPush,
    SessionId,
    SupportedLocale,
    WorkspaceId,
} from "./frames.js";
import type { AgentMessage, AssistantMessage, ThinkingLevel } from "./messages.js";
import type { PlanStateUpdatedParams, TasksUpdatedParams } from "./push.js";

export interface SessionMeta {
    id: SessionId;
    cwd: WorkspaceId;
    /** Absolute path to the .jsonl session file. */
    filePath: string;
    /** ISO creation timestamp. */
    createdAt: string;
    /** Session kind: main or subagent. */
    kind?: "main" | "subagent";
    /** Agent type (e.g. "claude-code", "bash-expert"). */
    agentType?: string;
    /** Parent session ID (subagent only). */
    parentSessionId?: SessionId;
    /** Tool call ID that triggered this subagent. */
    parentToolCallId?: string;
    /** Session depth (0 for main). */
    depth?: number;
    /** User-defined title from the most recent session_info event. */
    name?: string;
    /** IM routing triple. The authoritative source for ConversationRouter's route rebuilds. */
    imRouting?: {
        channelId: string;
        peerId: string;
        chatId: string;
    };
}

/** Default page size for `session.list` when the caller omits `limit`. */
export const SESSION_LIST_DEFAULT_LIMIT = 30;

/** Upper bound the server clamps `limit` to, so one call cannot read unbounded. */
export const SESSION_LIST_MAX_LIMIT = 200;

/** Result shape of `session.list` (workspace + sessions under it). */
export interface SessionListResult {
    workspace: WorkspaceId;
    sessions: SessionListEntry[];
    /** Opaque seek cursor for the next page. Undefined = no more pages. */
    nextCursor?: SessionListCursor;
    /** Total session count in the workspace, always returned (paged or full).
     *  Cheap because the server already sorted the full set in memory to slice
     *  the page. Lets the sidebar show the workspace total rather than the
     *  number of rows currently loaded. */
    total?: number;
}

/** Opaque composite cursor for seek pagination. Pairs (updatedAt, id) so that
 *  mtime ties (assistant final writes within the same second) still resolve to a
 *  stable, total ordering across pages. */
export interface SessionListCursor {
    updatedAt: string;
    id: SessionId;
}

/** Params for `session.list`. */
export interface SessionListParams {
    workspace: WorkspaceId;
    /** Page size. Omitted or <= 0 means SESSION_LIST_DEFAULT_LIMIT; the server
     *  clamps to SESSION_LIST_MAX_LIMIT. */
    limit?: number;
    /** Cursor returned from a previous list result. Undefined = first page. */
    cursor?: SessionListCursor;
    /** When true, ignore pagination and return the full list (plus `total`).
     *  Used by the client to refresh the sidebar — discards any in-progress
     *  pagination state. */
    full?: boolean;
}

export interface SessionListEntry {
    id: SessionId;
    cwd: WorkspaceId;
    filePath: string;
    createdAt: string;
    /** ISO mtime of the .jsonl, read server-side. Undefined when statSync failed
     *  (file deleted / no permission); clients fall back to createdAt. */
    updatedAt?: string;
    kind?: "main" | "subagent";
    agentType?: string;
    parentSessionId?: SessionId;
    parentToolCallId?: string;
    depth?: number;
    /** User-defined title from the most recent session_info event. */
    name?: string;
}

export interface SessionHistoryEntry {
    /** Entry id (uuidv7). */
    id: string;
    /** Parent entry id; null for the root. */
    parentId: string | null;
    /** Entry type. */
    type: string;
    /** Entry payload. */
    payload: unknown;
    /** ISO timestamp. */
    timestamp: string;
}

export interface SessionHistory {
    sessionId: SessionId;
    /** Leaf entry id (clients use it to rebuild branches). */
    leafEntryId: string | null;
    entries: SessionHistoryEntry[];
}

/** Request the retained realtime frames after a contiguous session cursor. */
export interface SessionEventsGetParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    afterSeq: number;
}

/** Bounded replay result. `resetRequired` means the client must pull authoritative snapshots. */
export interface SessionEventsGetResult {
    events: ServerPush[];
    firstSeq: number;
    lastSeq: number;
    resetRequired: boolean;
}

/** Request one consistent session-state snapshot and its replay watermark. */
export interface SessionSnapshotGetParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
}

/**
 * Authoritative state at `snapshotSeq`. Clients must replay only frames after
 * that cursor; task and plan state are absent for subagent sessions.
 */
export interface SessionSnapshot {
    sessionId: SessionId;
    sessionKind: "main" | "subagent";
    snapshotSeq: number;
    history: SessionHistory;
    tasks?: Pick<TasksUpdatedParams, "active" | "history">;
    planState?: Pick<PlanStateUpdatedParams, "active" | "currentSlug">;
}

export interface CreateSessionParams {
    workspace: WorkspaceId;
    /** Optional client-supplied id. */
    sessionId?: SessionId;
    /** First user message (recorded as the first entry + triggers agent prompt). */
    initialPrompt?: string;
    /**
     * Images attached to the first user message. May be sent with or without
     * `initialPrompt` (image-only prompts are allowed).
     */
    initialImages?: ImageInput[];
    /** Session-level override; defaults to workspace default (then taco.json / CLI). */
    thinkingLevel?: ThinkingLevel;
    /**
     * Desktop UI language at the moment this session is created. Server passes
     * it through to `AttachedSession.uiLocaleRef` so the first `<reply_language>`
     * tag (per-turn context hook) reflects the UI. Never persisted.
     */
    uiLocale?: SupportedLocale;
    /** IM routing triple, written to jsonl metadata as the authoritative routing source. */
    imRouting?: {
        channelId: string;
        peerId: string;
        chatId: string;
    };
}

export interface CreateSessionResult {
    sessionId: SessionId;
    filePath: string;
    /** Final assistant message of the first turn; null when no initial prompt ran. */
    assistantMessage: AssistantMessage | null;
}

export interface AttachParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    /** Initial thinking level for this harness. Already-attached sessions are not overwritten. */
    thinkingLevel?: ThinkingLevel;
}

export interface PromptParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    text: string;
    images?: ImageInput[];
    /**
     * Desktop UI language for THIS turn only. Server injects a transient
     * `<reply_language>` tag if set. Updates the live uiLocaleRef so subsequent
     * turns of the same session keep matching the user's latest UI choice.
     */
    uiLocale?: SupportedLocale;
    /**
     * Model override applied when this prompt attaches the session (the first
     * turn of a brand-new session). Ignored for already-attached sessions —
     * callers must use `session.setModel` to switch those. Lets the desktop
     * honour a model picked on a fresh session before its id exists.
     */
    model?: { provider: string; id: string };
}

/**
 * `session.prompt` RPC result — a structured turn outcome.
 *
 * Before this was typed it was `unknown`, and the desktop client bridged it
 * with an unchecked `as AgentMessage`, so the sidecar could change the shape
 * silently. Wrapping in an object keeps the contract explicit and leaves room
 * to add turn-level fields (assistantMessageId, stopReason) without another
 * breaking change.
 */
export interface PromptResult {
    /** The final assistant message of the completed turn. */
    assistantMessage: AgentMessage;
}

export interface SteerParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    text: string;
    /**
     * Desktop UI language for THIS steer. Same semantics as PromptParams.uiLocale.
     */
    uiLocale?: SupportedLocale;
}

export interface AbortParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
}

/** Explicit outcome for an idempotent cancellation request. */
export interface AbortResult {
    status: "aborted" | "not_running";
}

export interface DeleteSessionParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
}

export interface RenameSessionParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    /** New title; empty string is allowed (server trims to empty, last write wins). */
    name: string;
}

export interface SetModelParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    /** Provider id, e.g. "anthropic" / "openai". */
    provider: string;
    /** Model id, e.g. "claude-sonnet-4-5". */
    modelId: string;
}

export interface ListModelsParams {
    workspace: WorkspaceId;
    /** Optional provider filter. */
    provider?: string;
}

/** `providers.list` RPC params. */
export interface ProvidersListParams {
    workspace: WorkspaceId;
}

/** Provider availability view (one entry in `providers.list` result). */
export interface ProviderView {
    id: string;
    name: string;
    /** Whether a key is configured. */
    configured: boolean;
    /** Whether this is a user-defined provider. */
    custom: boolean;
    /** Models available under this provider. */
    models: Array<{ provider: string; id: string; name?: string }>;
}

/** `providers.list` RPC result — built-in + custom provider availability. */
export interface ProvidersListResult {
    providers: ProviderView[];
}

/**
 * `provider.listModels` RPC params.
 *
 * Configuration-time helper: a top-level (workspace-less) RPC used by the
 * custom-provider form to populate the "model id" textarea from the remote
 * provider's `/v1/models`. The `apiKey` is the literal value the user typed
 * in the form (the store has not been written yet at this point).
 */
export interface ProviderListModelsParams {
    baseUrl: string;
    api: CustomProviderApi;
    apiKey: string;
}

/**
 * Discriminated result — handlers branch on `api` and either return a model
 * id list or report that the protocol has no public catalog endpoint.
 * `message` is human-readable and safe to surface verbatim (no API key).
 */
export type ProviderListModelsResult =
    | { ok: true; models: string[] }
    | {
          ok: false;
          reason: "protocol-not-supported" | "http-error" | "timeout" | "invalid-response";
          message: string;
      };

/** `session.setThinkingLevel` RPC params. */
export interface SessionSetThinkingLevelParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    level: ThinkingLevel;
}

/** `session.compact` RPC params — manually trigger compaction. */
export interface SessionCompactParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    /** Optional custom instructions (forwarded to pi `harness.compact(customInstructions)`). */
    customInstructions?: string;
}

/** `session.compact` RPC result — success/failure only, never the artefact. */
export interface SessionCompactResult {
    ok: boolean;
    /** Tokens used before compaction, from the session.compact event's compactionEntry. */
    tokensBefore?: number;
    /** True if a hook provided the summary (our pin-aware hook reports `fromHook=true`). */
    fromHook?: boolean;
    /**
     * Why the compaction failed. Absent when `ok` is true. Lets the UI pick a
     * message ("aborted" vs "timeout") without parsing sidecar logs.
     */
    reason?: CompactionFailureReason;
}

/** `session.contextInfo` RPC params — pulls a snapshot of current context usage. */
export interface SessionContextInfoParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
}

/** `session.contextInfo` RPC result — authoritative source for the desktop top-bar indicator. */
export interface SessionContextInfoResult {
    modelId: string;
    provider: string;
    contextWindow: number;
    /** Estimated used tokens (based on the most recent assistant usage anchor + chars/4 heuristic). */
    usedTokens: number;
    /** usedTokens / contextWindow. May exceed 1.0 if over the limit. */
    ratio: number;
    /** Timestamp of the most recent compaction entry (ISO); rebuildable from session storage after sidecar restart. */
    lastCompactionAt?: string;
    /** Cumulative cache-hit tokens read from the provider cache across the whole session tree
     *  (continuous across compactions/restarts). Aligned with pi-ai `Usage.cacheRead` and
     *  pi `SessionStats.cachedTokens` (the two are equal). */
    cacheRead?: number;
    /** Prompt-cache hit / reuse ratio = ΣcacheRead / Σ(input + cacheRead). Range 0..1;
     *  omitted when there are no cacheable input records. The denominator excludes
     *  cacheWrite (the unavoidable first-turn write cost) and output, which is the
     *  Anthropic prompt-cache convention. See ContextInfoService notes. */
    cacheHitRatio?: number;
}
