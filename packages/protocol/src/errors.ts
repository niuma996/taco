/**
 * Error code constants — stable wire strings for the `RpcResponse.error.code`
 * field. Mirrors `PushMethods` style (PascalCase keys, snake_case values).
 *
 * Rules for new entries: codes may be ADDED in minor versions; renaming or
 * removal is a major-version bump. The string values are wire-stable and
 * external clients may key behavior off them.
 */

/** Error code constants. The string values are wire-stable. */
export const ErrorCodes = {
    /** Caller-supplied params failed type/schema validation (includes path info when available). */
    InvalidParams: "invalid_params",
    /** Server state doesn't permit the requested operation. */
    InvalidState: "invalid_state",
    /** Client protocol version not compatible with sidecar. */
    IncompatibleProtocol: "incompatible_protocol",
    /** A value (env var, config field) was set but unusable. */
    InvalidValue: "invalid_value",
    /** Resource not found (session, workspace, skill, etc.). */
    NotFound: "not_found",
    /** Memory.upsert id conflict (target id exists for add / missing for replace). */
    IdConflict: "id_conflict",
    /** Memory write lost the baseHash race; client must re-read and retry. */
    MemoryConflict: "memory.conflict",
    /** Session snapshot was concurrently mutated mid-read. */
    SnapshotUnstable: "snapshot_unstable",
    /** checkpoints.restore failed (file changed under us, etc.). */
    CheckpointRestoreFailed: "checkpoint_restore_failed",
    /** WeChat SDK binary missing on this host. */
    WechatSdkMissing: "wechat_sdk_missing",
    /** RPC called before `initialize` completed. */
    NotInitialized: "not_initialized",
    /** Unknown method name. */
    UnknownMethod: "unknown_method",
    /**
     * The `(workspace, session)` cannot start a turn right now: another turn
     * command is active, an in-flight compaction did not settle, or the harness
     * reported busy. Transient — callers may retry.
     */
    SessionBusy: "session_busy",
    /** commandId reuse with mismatched params. */
    CommandIdConflict: "command_id_conflict",
    /** Catch-all internal server error. */
    Internal: "internal",
} as const;

/** Union of all error code string literals. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
