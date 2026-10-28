/**
 * ServerRpcSurface — the narrow server view that handlers registered in
 * methods.ts see. Extracts only the method signatures handlers actually use,
 * so methods.ts depends on this interface instead of `SidecarServer` directly
 * (breaking the methods.ts ↔ server.ts import cycle).
 *
 * Relationship: `class SidecarServer implements ServerRpcSurface`.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type {
    ChannelsBindCreds,
    ChannelsBindResult,
    ChannelsCreateResult,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ChannelsRetryResult,
    ClientCapabilities,
    CustomProviderApi,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImRoute,
    ImWorkspacePolicyPatch,
    RpcRequest,
    RpcResponse,
    SessionEventsGetResult,
    SessionId,
    SidecarCapabilities,
    WorkspaceAssociationKey,
    WorkspaceId,
} from "@taco-ai/protocol";
import type { ExtensionRegistry } from "../extensions/index.ts";
import type { Actor, Job, JobHistoryEntry, JobRunResult } from "../scheduler/types.ts";
import type { ProviderKeyStore } from "./models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "./workspace.ts";

/**
 * The IM channel operations the `channels.*` handlers need. Kept narrow so the
 * handler layer never reaches into ChannelRegistry / ChannelBindBroker directly.
 */
export interface ChannelControl {
    list(): ChannelsListResult;
    listConversations(channelId?: string): ChannelsListConversationsResult;
    create(name: string, channelId?: string): ChannelsCreateResult;
    bind(
        channelId: string,
        force?: boolean,
        creds?: ChannelsBindCreds,
    ): Promise<ChannelsBindResult>;
    submitVerifyCode(requestId: string, code: string): boolean;
    unbind(channelId: string): Promise<void>;
    /** Reconnect using the channel's already-stored credentials. For
     *  platforms whose SDK caches credentials in its long-poll client and
     *  refuses to retry past its reconnect budget — the only path back from
     *  error without retyping the secret. */
    retry(channelId: string): Promise<ChannelsRetryResult>;
}

/**
 * The workspace directory-association operations the `workspace.associations.*`
 * handlers need. Mirrors `ImPolicyControl`: handlers reach this through
 * `server.associations`, not through the store.
 *
 * The store itself is file-backed and read on every use, so the *enforcement*
 * of a change is immediate everywhere in the process — no invalidation
 * needed. What the control adds is the push fan-out: the server that owns
 * the affected workspaces is the one that can address them, and in daemon
 * mode the IM workspaces live on the resident host rather than on the
 * connection server that received the request.
 */
export interface WorkspaceAssociationsControl {
    get(key: WorkspaceAssociationKey): string[];
    set(key: WorkspaceAssociationKey, roots: readonly string[]): Promise<string[]>;
    resolve(workspace: WorkspaceId): { roots: string[]; source?: WorkspaceAssociationKey };
    /** Announce that a set changed, to every workspace it affects. */
    broadcastChanged(key: WorkspaceAssociationKey): void;
}

/**
 * The IM workspace policy operations the `imPolicy.*` handlers need. Mirrors
 * `ChannelControl`: handlers reach this through `server.imPolicy`, not through
 * the store / SidecarServer internals. Writes delegate to
 * `SidecarServer.setIm* / clearIm*` so the workspace cache is invalidated
 * atomically with the persist.
 */
export interface ImPolicyControl {
    get(params: ImPolicyGetParams): Promise<ImPolicyGetResult>;
    setChannelDefault(channelId: string, patch: ImWorkspacePolicyPatch): Promise<void>;
    setChatOverride(route: ImRoute, patch: ImWorkspacePolicyPatch): Promise<void>;
    /**
     * Clear a chat override. Pass `route` for live conversations; pass
     * `chatKey` (the raw sha256 hex from `ImPolicyChatOverrideEntry.key`)
     * for orphan overrides where the route is lost.
     */
    clearChatOverride(
        input: { route: ImRoute } | { chatKey: string },
        channelId: string,
    ): Promise<void>;
}

/**
 * Scheduler-facing operations exposed to the `jobs.*` RPC handlers. The
 * store + scheduler live behind this interface so handlers don't reach
 * into scheduler internals; SidecarServer implements the contract using
 * the JobStore + Scheduler that runDaemon constructed at startup.
 *
 * Every method takes an optional `actor` so the server can enforce
 * IM-scope (caller's channelId + peerId must match the job) vs IDE-scope
 * (caller's workspace must match the job's args.workspace). `undefined`
 * means legacy / admin caller — all jobs are visible and modifiable.
 */
export interface JobsControl {
    list(actor?: Actor): Promise<Job[]>;
    get(id: string, actor?: Actor): Promise<Job | null>;
    create(job: Job, actor?: Actor): Promise<Job>;
    update(job: Job, actor?: Actor): Promise<Job>;
    delete(id: string, actor?: Actor): Promise<void>;
    runNow(id: string, actor?: Actor): Promise<JobRunResult>;
    history(id: string, actor?: Actor): Promise<JobHistoryEntry[] | null>;
}

export interface ServerRpcSurface {
    workspaceIds(): WorkspaceId[];
    ensureWorkspace(cwd: WorkspaceId): Promise<WorkspaceRuntime>;
    disposeWorkspace(cwd: WorkspaceId): Promise<void>;
    getSessionEvents(
        workspace: WorkspaceId,
        sessionId: SessionId,
        afterSeq: number,
    ): SessionEventsGetResult;
    getSessionLastSeq(workspace: WorkspaceId, sessionId: SessionId): number;
    clearSessionEvents(workspace: WorkspaceId, sessionId: SessionId): void;
    /**
     * Seed the replay ring for a session from its disk tail (no-op while the
     * in-memory ring is live). Handlers that can observe the session's first
     * frame after a sidecar restart (attach / events.get / snapshot.get) call
     * this first so seq numbering continues instead of resetting to 1.
     */
    hydrateSessionEvents(workspace: WorkspaceId, sessionId: SessionId): Promise<void>;
    readonly extensionRegistry?: ExtensionRegistry;
    /**
     * Process-level API key store. The `settings.write` handler calls `update()` to trigger hot reload —
     * pi's `Models` reads keys lazily via CredentialStore.read per provider id,
     * without recomputing the catalog.
     *
     * Required: SidecarServer must hold a store; handlers call it directly, not `?.()`
     * (silent best-effort). TypeScript enforces coverage at compile time.
     */
    readonly providerKeyStore: ProviderKeyStore;
    /** Re-resolve effective configuration and apply each changed field once. */
    refreshConfiguration(): Promise<void>;
    /**
     * Resolve a registered provider's endpoint for model discovery
     * (provider.listModels "saved" branch). Undefined for unknown providers.
     */
    getProviderEndpoint?(
        providerId: string,
    ): { baseUrl: string; api: CustomProviderApi } | undefined;
    /**
     * Build the pi Provider for a registered id (provider.testConnection
     * "saved" branch), with the user's model-list edits applied so a test can
     * target an added model. Undefined for unknown providers.
     */
    buildProvider?(providerId: string): Provider | undefined;
    /**
     * IM channel control surface, consumed by the `channels.*` handlers.
     * Optional so non-SidecarServer hooks (tests) need not implement it;
     * handlers reject with `invalid_state` when absent.
     */
    readonly channels?: ChannelControl;
    /**
     * Scheduler API exposed to the `jobs.*` RPC handlers. Same optionality
     * as `channels` — tests / non-daemon hosts can omit it.
     */
    readonly jobs?: JobsControl;
    /**
     * Mount/replace the scheduler API after the server is up. The daemon
     * constructs the controller after the resident SidecarServer has started
     * (the controller's Scheduler needs the resident's RPC surface); this
     * setter is the post-start hook for closing that loop. No-op when absent
     * (e.g. test stubs that own their own jobs field).
     */
    setJobsControl?(next: JobsControl | undefined): void;
    /**
     * IM workspace policy control surface, consumed by the `imPolicy.*`
     * handlers. Same optionality as `channels` — non-SidecarServer hooks
     * (tests) need not implement it.
     */
    readonly imPolicy?: ImPolicyControl;
    /**
     * Workspace directory-association control surface, consumed by the
     * `workspace.associations.*` handlers. Present on every server — the
     * store is file-backed, so every server in the process sees the same
     * sets.
     */
    readonly associations: WorkspaceAssociationsControl;
    /**
     * Whether the sidecar is currently compacting (during auto-compaction summary LLM call).
     * Handler entry checks this to decide whether to take the short-circuit path.
     */
    isCompressing(cwd: WorkspaceId, sessionId: SessionId): boolean;
    /**
     * Wait for the current compaction to finish; releases after timeout.
     * (Handler may still hit pi busy — pi itself throws and preserves the original behaviour.)
     * See `SidecarServer.awaitCompactionEnd` for details.
     */
    awaitCompactionEnd(
        cwd: WorkspaceId,
        sessionId: SessionId,
        timeoutMs?: number,
    ): Promise<boolean>;
    /**
     * Dispatch a complete RpcRequest in-process (via handler registry / middleware / error translation).
     * Used by self-RPC tools (e.g. memory tool in the same process) — avoids splitting IPC.
     * `SidecarServer` always provides this; other implementations may omit it.
     */
    dispatchRpc?(req: RpcRequest): Promise<RpcResponse>;
    /**
     * Mark this sidecar process as initialized by the connected stdio client.
     * Called by the `initialize` handler after the client's protocol version
     * is accepted; subsequent RPCs from that client pass the
     * `not_initialized` guard. In-process callers are never gated.
     */
    markInitialized(capabilities: ClientCapabilities): void;
    /**
     * Authoritative server capability advertisement, returned by `initialize`.
     */
    getServerCapabilities(): SidecarCapabilities;
    /** Refresh MCP defaults for future workspace builds without interrupting live sessions. */
    reloadMcpServers?(): Promise<void>;

    /** Rescan agent definitions into every workspace after agents.write/delete. */
    reloadAgents?(): Promise<void>;
}
