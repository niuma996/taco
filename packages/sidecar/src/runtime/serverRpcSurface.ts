/**
 * ServerRpcSurface — the narrow server view that handlers registered in
 * methods.ts see. Extracts only the method signatures handlers actually use,
 * so methods.ts depends on this interface instead of `SidecarServer` directly
 * (breaking the methods.ts ↔ server.ts import cycle).
 *
 * Relationship: `class SidecarServer implements ServerRpcSurface`.
 */
import type {
    ChannelsBindResult,
    ChannelsCreateResult,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ClientCapabilities,
    CustomProviderConfig,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImRoute,
    ImWorkspacePolicyPatch,
    InstructionsConfig,
    RpcRequest,
    RpcResponse,
    SessionEventsGetResult,
    SessionId,
    SidecarCapabilities,
    WorkspaceId,
} from "@taco-ai/protocol";
import type { ExtensionRegistry } from "../extensions/index.ts";
import type { ProviderKeyStore } from "./providerKeyStore.ts";
import type { WorkspaceRuntime } from "./workspace.ts";

/**
 * The IM channel operations the `channels.*` handlers need. Kept narrow so the
 * handler layer never reaches into ChannelRegistry / ChannelBindBroker directly.
 */
export interface ChannelControl {
    list(): ChannelsListResult;
    listConversations(channelId?: string): ChannelsListConversationsResult;
    create(name: string, channelId?: string): ChannelsCreateResult;
    bind(channelId: string, force?: boolean): Promise<ChannelsBindResult>;
    submitVerifyCode(requestId: string, code: string): boolean;
    unbind(channelId: string): Promise<void>;
}

/**
 * The IM workspace policy operations the `imPolicy.*` handlers need. Mirrors
 * `ChannelControl`: handlers reach this through `server.imPolicy`, not through
 * the store / SidecarServer internals. Writes delegate to
 * `SidecarServer.setIm* / clearIm*` so the workspace cache is invalidated
 * atomically with the persist.
 */
export interface ImPolicyControl {
    get(params: ImPolicyGetParams): ImPolicyGetResult;
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
    /**
     * Replace the custom provider set (called by handler after settings.write changes customProviders).
     * Existing workspaces' ModelRegistry receives the update and reconciles (add/remove custom ids, builtin untouched);
     * newly created workspaces read the latest value automatically.
     */
    setCustomProviders?(next: readonly CustomProviderConfig[]): void;
    /**
     * Invalidate compaction caches for all workspaces' attached sessions.
     * Called by `settings.write` after writing the compaction field, ensuring a threshold change
     * takes effect immediately in the current session's next `effectiveCompaction()` call
     * (without waiting for TTL expiry).
     *
     * Required: SidecarServer must implement this method; handlers call it directly, not `?.()`
     * (silent best-effort). TypeScript enforces coverage at compile time.
     */
    invalidateCompactionCaches(): void;
    /**
     * Hot-reload the `InstructionsConfig` for every workspace. Called by the
     * `settings.write` handler after writing the `instructions` field so the
     * next LLM call in every session picks up the new behavior. The context
     * hook reads via a lazy thunk on every call, so this swap is sufficient
     * — no per-session invalidation is required.
     */
    refreshInstructions(next: InstructionsConfig | undefined): void;
    /**
     * Broadcast a `models.changed` push to every workspace. Called by the
     * `settings.write` handler after `apiKeys` or `customProviders` change,
     * so the desktop re-pulls `providers.list` / `session.listModels`
     * without a restart.
     */
    broadcastModelsChanged(): void;
    /**
     * IM channel control surface, consumed by the `channels.*` handlers.
     * Optional so non-SidecarServer hooks (tests) need not implement it;
     * handlers reject with `invalid_state` when absent.
     */
    readonly channels?: ChannelControl;
    /**
     * IM workspace policy control surface, consumed by the `imPolicy.*`
     * handlers. Same optionality as `channels` — non-SidecarServer hooks
     * (tests) need not implement it.
     */
    readonly imPolicy?: ImPolicyControl;
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
}
