/**
 * session.* RPC params/result types — lifecycle (create/attach/detach/delete),
 * turn (prompt/steer/abort), runtime (setModel/setThinkingLevel/compact/
 * contextInfo), and snapshot/history reads. Depends on frames for routing
 * keys and push for TasksUpdatedParams/PlanStateUpdatedParams shape.
 */

import type { CustomProviderApi } from "./config.js";
import type { CompactionFailureReason, ServerPush, SessionId, WorkspaceId } from "./frames.js";
import type { AgentMessage } from "./messages.js";
import type { PlanStateUpdatedParams, TasksUpdatedParams } from "./push.js";
import type { ParamsOf } from "./rpcContract/types.js";
import type {
    providerListModelsSchema,
    providersListSchema,
    providersRevealKeySchema,
    providerTestConnectionSchema,
    sessionListModelsSchema,
} from "./schemas/catalog.js";
import type {
    sessionAttachSchema,
    sessionCreateSchema,
    sessionDeleteSchema,
    sessionDetachSchema,
    sessionListSchema,
    sessionRenameSchema,
} from "./schemas/sessionLifecycle.js";
import type {
    sessionEventsGetSchema,
    sessionHistorySchema,
    sessionPlanStateGetSchema,
    sessionSnapshotGetSchema,
    sessionTaskHistoryGetSchema,
    sessionTasksGetSchema,
} from "./schemas/sessionRead.js";
import type {
    sessionAbortSchema,
    sessionCancelQueuedSchema,
    sessionCompactSchema,
    sessionContextInfoSchema,
    sessionPromptSchema,
    sessionSetModelSchema,
    sessionSetThinkingLevelSchema,
    sessionSteerSchema,
    subagentAbortSchema,
} from "./schemas/sessionTurn.js";

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
export type SessionListParams = ParamsOf<typeof sessionListSchema>;

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
    /**
     * Message records in the session file — an estimate (abandoned branches
     * count too) for sizing a loading placeholder before the history arrives.
     * Absent from older sidecars.
     */
    messageCount?: number;
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
export type SessionEventsGetParams = ParamsOf<typeof sessionEventsGetSchema>;

/** Bounded replay result. `resetRequired` means the client must pull authoritative snapshots. */
export interface SessionEventsGetResult {
    events: ServerPush[];
    firstSeq: number;
    lastSeq: number;
    resetRequired: boolean;
}

/** Request one consistent session-state snapshot and its replay watermark. */
export type SessionSnapshotGetParams = ParamsOf<typeof sessionSnapshotGetSchema>;

/** `session.tasks.get` params — the current task list of an attached session. */
export type SessionTasksGetParams = ParamsOf<typeof sessionTasksGetSchema>;

/** `session.taskHistory.get` params — one history list, expanded to its items. */
export type SessionTaskHistoryGetParams = ParamsOf<typeof sessionTaskHistoryGetSchema>;

/** `session.planState.get` params — the current plan-mode state. */
export type SessionPlanStateGetParams = ParamsOf<typeof sessionPlanStateGetSchema>;

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

export type CreateSessionParams = ParamsOf<typeof sessionCreateSchema>;

export interface CreateSessionResult {
    sessionId: SessionId;
    filePath: string;
    /** Terminal message of the first turn (assistant message under normal
     *  flows, or a toolResult when the first turn closed on a terminating
     *  tool call like askUser / planExit); null when no initial prompt ran. */
    assistantMessage: AgentMessage | null;
}

export type AttachParams = ParamsOf<typeof sessionAttachSchema>;

/** `session.attach` params — the attach envelope plus the initial thinking level. */
export type SessionAttachParams = AttachParams;

/** `session.detach` params — the session to detach; no thinking level applies. */
export type SessionDetachParams = ParamsOf<typeof sessionDetachSchema>;

/** `session.history` params — the session whose transcript to replay. */
export type SessionHistoryParams = ParamsOf<typeof sessionHistorySchema>;

export type PromptParams = ParamsOf<typeof sessionPromptSchema>;

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

export type SteerParams = ParamsOf<typeof sessionSteerSchema>;

/**
 * `session.steer` / `session.followUp` result. Both are pure enqueues: with no
 * active run the message would sit in the lane inbox silently until the next
 * prompt, so the server reports which side of that line the call landed on and
 * the client falls back to `session.prompt` when idle.
 */
export type SteerResult =
    | {
          /** A run is in flight and will consume the message at a boundary. */
          mode: "queued";
          /**
           * The queue entry just written. Clients key their optimistic queue row
           * on this so the `queue_update` push reconciles by identity — matching
           * on message text instead conflates two identical messages.
           */
          entryId: string;
      }
    | { mode: "idle" };

/**
 * Params for `session.followUp`. Identical wire shape to steer — the two differ
 * only in when pi consumes the entry, not in what the caller sends.
 */
export type FollowUpParams = SteerParams;

/**
 * `session.followUp` result. Same contract as steer: pi's queue write returns
 * the same `{ entryId }` either way.
 */
export type FollowUpResult = SteerResult;

/** Params for `session.cancelQueued` — remove one not-yet-consumed queue entry. */
export type CancelQueuedParams = ParamsOf<typeof sessionCancelQueuedSchema>;

/** `session.cancelQueued` result — mirrors pi's CancelQueuedResult kind. */
export interface CancelQueuedResult {
    kind: "cancelled" | "already_consumed" | "not_found";
}

export type AbortParams = ParamsOf<typeof sessionAbortSchema>;

/** Explicit outcome for an idempotent cancellation request. */
export interface AbortResult {
    status: "aborted" | "not_running";
    /**
     * Text of steering messages the abort drained from the lane inbox, in
     * drain order, with empty (image-only) messages omitted. Present — possibly
     * as an empty array — when status is "aborted"; absent entirely when status
     * is "not_running". Clients restore these into the composer so an
     * interrupted steer is not lost.
     */
    discardedSteer?: string[];
    /** Same contract as discardedSteer, for pi's separate follow-up queue. */
    discardedFollowUp?: string[];
}

/** `subagent.abort` params — stop one running subagent without touching its parent's turn. */
export type SubagentAbortParams = ParamsOf<typeof subagentAbortSchema>;

/** Explicit outcome for an idempotent subagent-stop request. */
export interface SubagentAbortResult {
    /**
     * `not_running` means the child already settled (or never ran in this
     * process) — there was nothing to stop. The stop itself is asynchronous:
     * the sync caller's tool result or the background notification carries
     * the outcome through the normal settle path.
     */
    status: "aborted" | "not_running";
}

export type DeleteSessionParams = ParamsOf<typeof sessionDeleteSchema>;

export type RenameSessionParams = ParamsOf<typeof sessionRenameSchema>;

export type SetModelParams = ParamsOf<typeof sessionSetModelSchema>;

export type ListModelsParams = ParamsOf<typeof sessionListModelsSchema>;

/** `providers.list` RPC params. */
export type ProvidersListParams = ParamsOf<typeof providersListSchema>;

/** Provider availability view (one entry in `providers.list` result). */
export interface ProviderView {
    id: string;
    name: string;
    /** Whether a key is configured. */
    configured: boolean;
    /** Whether this is a user-defined provider. */
    custom: boolean;
    /**
     * Endpoint base URL. Read-only for built-ins (their catalog is fixed by
     * pi); editable through the custom-provider config for customs.
     */
    baseUrl?: string;
    /** Protocol family. Read-only for built-ins, like baseUrl. */
    api?: CustomProviderApi;
    /** Models available under this provider. */
    models: Array<{
        provider: string;
        id: string;
        name?: string;
        /**
         * Provenance: "builtin" = pi static list (read-only in the UI),
         * "extra" = user-added on a built-in provider (removable),
         * "custom" = belongs to a custom provider (editable via that provider),
         * "hidden" = a static model the user removed; still listed so the
         * settings UI can offer a restore action.
         */
        origin?: "builtin" | "extra" | "custom" | "hidden";
        /**
         * Context window in tokens. A user-added model carries the value the
         * user declared; a catalog model carries pi's own. Absent when the
         * model declares none.
         */
        contextWindow?: number;
        /** Per-output cap in tokens. Absent when the model declares none. */
        maxTokens?: number;
        /**
         * Whether the model reasons before answering, as the user declared it
         * for an added model. Absent means the provider's default applies.
         */
        reasoning?: boolean;
    }>;
}

/** `providers.list` RPC result — built-in + custom provider availability. */
export interface ProvidersListResult {
    providers: ProviderView[];
}

/** `providers.revealKey` RPC params — returns the plaintext key for one provider. */
export type ProvidersRevealKeyParams = ParamsOf<typeof providersRevealKeySchema>;

/** `providers.revealKey` RPC result — `null` when no key is configured. */
export interface ProvidersRevealKeyResult {
    key: string | null;
}

/**
 * `provider.listModels` RPC params.
 *
 * Two shapes:
 * - `endpoint`: fetch `{baseUrl}/models` with the literal key the user typed
 *   (custom-provider form — the store has not been written yet).
 * - `saved`: resolve baseUrl/api from the registered provider (built-in table
 *   or customProviders) and the key from the sidecar's ProviderKeyStore, so
 *   plaintext keys never cross the wire for already-saved providers.
 */
export type ProviderListModelsParams = ParamsOf<typeof providerListModelsSchema>;

/**
 * Discriminated result — either a model id list or why the probe failed.
 * `message` is human-readable and safe to surface verbatim (no API key).
 */
export type ProviderListModelsResult =
    | { ok: true; models: string[] }
    | {
          ok: false;
          reason: ProviderListModelsFailureReason;
          message: string;
      };

/**
 * `provider.testConnection` RPC params — sends one minimal chat turn through
 * the same pi streaming path a session uses, so a pass means key, endpoint,
 * protocol and model id all work together.
 *
 * Two shapes, mirroring `provider.listModels`:
 * - `{ providerId, modelId, apiKey? }` — a saved provider. The key comes from
 *   the sidecar's store unless `apiKey` is given (a key typed but not yet
 *   saved), so stored keys never cross the wire.
 * - `{ baseUrl, api, apiKey, modelId }` — the create-custom form, before any
 *   provider is registered.
 */
export type ProviderTestConnectionParams = ParamsOf<typeof providerTestConnectionSchema>;

/**
 * `provider.testConnection` result. Probe failures are a normal outcome, not
 * an RPC error: the RPC itself only rejects on malformed params.
 * `message` is human-readable and safe to surface verbatim (no API key).
 */
export type ProviderTestConnectionResult =
    | {
          ok: true;
          /** Round-trip time of the probe, in milliseconds. */
          latencyMs: number;
          /** The model that answered — echoes `responseModel` when the upstream reports one. */
          model: string;
          /** First characters of the reply, for a visual sanity check. */
          reply: string;
      }
    | {
          ok: false;
          reason: ProviderTestConnectionFailureReason;
          message: string;
          latencyMs: number;
      };

/**
 * Why a connection test failed. `auth` and `not-found` are split out from
 * `http-error` because they map to different fixes (check the key vs. check
 * the model id / endpoint); everything else unclassified is `error`.
 */
export type ProviderTestConnectionFailureReason =
    | "auth"
    | "not-found"
    | "rate-limited"
    | "timeout"
    | "network"
    | "error";

/**
 * Why a `provider.listModels` probe failed.
 *
 * `protocol-not-supported` is deprecated: since protocol 2.2 every protocol
 * shares the same `{baseUrl}/models` catalog, so the current sidecar never
 * returns it. It stays in the union because the type is published and pre-2.2
 * daemons still emit it — clients should treat it like any other failure and
 * show `message`.
 */
export type ProviderListModelsFailureReason =
    | "http-error"
    | "timeout"
    | "invalid-response"
    /** @deprecated Not emitted since protocol 2.2; see ProviderListModelsFailureReason. */
    | "protocol-not-supported";

/** `session.setThinkingLevel` RPC params. */
export type SessionSetThinkingLevelParams = ParamsOf<typeof sessionSetThinkingLevelSchema>;

/** `session.compact` RPC params — manually trigger compaction. */
export type SessionCompactParams = ParamsOf<typeof sessionCompactSchema>;

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
export type SessionContextInfoParams = ParamsOf<typeof sessionContextInfoSchema>;

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
     *  Anthropic prompt-cache convention. See ContextInfoService notes. Compaction
     *  and branch_summary entries (cacheRead=0) are included, so a more-aggressive
     *  compaction policy will pull this number down even when assistant turns hit. */
    cacheHitRatio?: number;
    /**
     * Same formula as `cacheHitRatio`, but counted over assistant `message`
     * entries only — compaction / branch_summary rows are left out. Lets the
     * UI tell "the metric was diluted by summarization" from "the prefix
     * actually missed". Omitted when there are no assistant usage records.
     */
    cacheHitRatioTurns?: number;
}
