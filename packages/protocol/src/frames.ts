/**
 * Wire frames — request/response/push shapes, routing keys, hello+capabilities.
 * No cross-file imports; the rest of the protocol depends on this.
 */

// Routing keys

/** Workspace ID = normalized cwd (project directory absolute path). */
export type WorkspaceId = string;

/** Languages the desktop UI knows how to render. */
export type SupportedLocale = "zh" | "en";

/** Session ID, server-generated. Clients may pass an id to reuse one. */
export type SessionId = string;

/**
 * Why a compaction did not produce a summary. Shared by the `session.compact`
 * RPC result (`SessionCompactResult.reason`) and the
 * `session.compaction_finished` push, so both report a failure identically —
 * clients branch on this, never on message text.
 *
 * Lives here rather than beside either consumer because `session.ts` already
 * imports `push.ts`; declaring it in either would make the two files circular.
 *
 * - `aborted` — the caller cancelled the operation.
 * - `timeout` — the operation ran out of time.
 * - `cancelled` — compaction was skipped by an explicit cancel signal.
 * - `busy` — the session was busy, so compaction could not start.
 * - `nothing` — there was no context to compact; not an error.
 * - `harness_error` — an unexpected harness-level failure.
 */
export type CompactionFailureReason =
    | "aborted"
    | "timeout"
    | "cancelled"
    | "busy"
    | "nothing"
    | "harness_error";

/** Current wire compatibility contract. A major mismatch is not interoperable.
 *  v2 dropped the `sidecar.hello` push frame; v1 clients are not accepted. */
export const SIDECAR_PROTOCOL_VERSION = { major: 2, minor: 0 } as const;

/**
 * Client-side gate for a sidecar's advertised protocol version. Semver-ish but
 * deliberately not semver-compat: major must match exactly, and the sidecar's
 * minor must be >= the client's. A newer sidecar (higher minor) is additive —
 * the client ignores methods it doesn't know. An older sidecar may lack methods
 * the client calls, so the client must reject it up front rather than fail on a
 * specific RPC at runtime. A missing/malformed protocol field rejects.
 */
export function isCompatibleSidecarProtocol(sidecar: { major: unknown; minor: unknown }): boolean {
    return (
        sidecar.major === SIDECAR_PROTOCOL_VERSION.major &&
        typeof sidecar.minor === "number" &&
        sidecar.minor >= SIDECAR_PROTOCOL_VERSION.minor
    );
}

/**
 * Server-side gate for an incoming `initialize` request's client protocol
 * version. Direction-aware counterpart to `isCompatibleSidecarProtocol`:
 * the server accepts a client whose major matches exactly and whose minor
 * is `<=` the server's. A client with a newer minor is rejected — the
 * server cannot honour methods it doesn't know about. A missing/malformed
 * protocol field rejects.
 */
export function isCompatibleClientProtocol(client: { major: unknown; minor: unknown }): boolean {
    return (
        client.major === SIDECAR_PROTOCOL_VERSION.major &&
        typeof client.minor === "number" &&
        client.minor <= SIDECAR_PROTOCOL_VERSION.minor
    );
}

/**
 * Client-declared capabilities negotiated via the `initialize` RPC. The
 * shape is open: `uiLocale` is the only field declared today, but the index
 * signature lets clients and servers agree on new fields without a protocol
 * bump. The server does not retain the declaration yet — nothing reads it.
 */
export interface ClientCapabilities {
    uiLocale?: SupportedLocale;
    [extension: string]: unknown;
}

/**
 * `initialize` RPC params — first client → server request on a connection.
 * Carries the client's protocol version (the server validates it with
 * `isCompatibleClientProtocol`) and the client's capability declaration.
 */
export interface InitializeParams {
    protocolVersion: { major: number; minor: number };
    clientCapabilities: ClientCapabilities;
}

/**
 * `initialize` RPC result — authoritative server capability advertisement.
 * `serverCapabilities` is the single source of truth for what this sidecar
 * process supports; the hello frame is liveness-only.
 */
export interface InitializeResult {
    serverVersion: string;
    serverCapabilities: SidecarCapabilities;
    protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
    /**
     * Stable for the lifetime of one sidecar process. Clients use it to detect
     * daemon replacement across reconnects. Supersedes the same field on the
     * deprecated `sidecar.hello` push frame.
     */
    instanceId: string;
    /** OS process id, for diagnostics only. Supersedes `sidecar.hello`'s pid. */
    pid: number;
    /**
     * Version of the on-disk session-history format (`SessionHistoryEntry.payload`)
     * this sidecar can read. History payloads are passthroughs of pi's jsonl
     * entries, which the wire protocol version does NOT cover — a pi upgrade can
     * change the format without touching `protocolVersion`. Clients should refuse
     * to render history from a sidecar advertising a version they don't understand.
     */
    sessionFormatVersion: number;
}

/** Session-history format the current sidecar build can read (pi jsonl `version`). */
export const CURRENT_SESSION_FORMAT_VERSION = 3;

/**
 * Push / RPC / channel / extension / experimental flags a sidecar advertises
 * at startup. Stable strings — never translate, never reuse. All fields are
 * additive: adding a capability does not require a protocol minor bump, and
 * bumping the protocol minor does not require new capabilities.
 */
export interface SidecarCapabilities {
    /** Pull-RPC method names the sidecar registers. Push methods live in
     * `pushes` and are NOT included here. */
    methods: readonly string[];
    /** Push method names the sidecar will emit. */
    pushes: readonly string[];
    /** Channel ids the sidecar actually started (IM, web, ...). */
    channels?: readonly string[];
    /** Experimental / unstable capabilities — gating on these is at the
     * client's risk; absent means the client didn't opt in. */
    experimental?: readonly string[];
}

/**
 * Image attached to a user prompt — `data` is raw base64 (no `data:` prefix),
 * aligned with `@earendil-works/pi-ai`'s `ImageContent`.
 */
export type ImageInput = {
    type: "image";
    data: string;
    mimeType: string;
};

// Pull (request/response) protocol

/** All client → sidecar RPC requests. */
export interface RpcRequest<TParams = unknown> {
    id: string;
    /** Stable caller-generated identity for retry-safe mutating commands. */
    commandId?: string;
    method: string;
    params: TParams;
}

/** Server → client RPC responses. */
export type RpcResponse<TResult = unknown> =
    | { id: string; ok: true; result: TResult }
    | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };

// Push (server-initiated)

/**
 * All server-pushed events use one frame. Clients dispatch by
 * `ev.method` / `ev.params`. The target is "all clients holding the
 * workspace handle".
 */
export interface ServerPush<TParams = unknown> {
    id?: string;
    method: string;
    workspace: WorkspaceId;
    session?: SessionId;
    /**
     * Monotonic per-(workspace, session) stream sequence. Absent for
     * process-wide pushes. See "Session Event Replay" in
     * `docs/sidecar-protocol.md` for gap detection and resetRequired rules.
     */
    seq?: number;
    /**
     * Session kind for this frame — clients use this to route events
     * to the main vs. subagent session. Defaults to "main".
     */
    sessionKind?: "main" | "subagent";
    params: TParams;
}
