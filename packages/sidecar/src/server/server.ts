import { disposeInOrder } from "../lib/async.ts";
/**
 * SidecarServer — NDJSON over stdio
 *
 * Read: one line per frame, parsed as RpcRequest, routed by method to handler.
 * Write: push frames from the workspace runtime are written directly to stdout.
 *
 * Push frame deduplication is NOT done here — the runtime guarantees it
 * does not emit duplicates; the server only does "serialize + write".
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import {
    asWorkspaceId,
    type ChannelStatusEntry,
    type ClientCapabilities,
    type CommandPermissionDecision,
    type CommandPermissionRequest,
    type CustomModelEntry,
    type CustomProviderApi,
    type CustomProviderConfig,
    ErrorCodes,
    IM_CWD_PREFIX,
    type InstructionsConfig,
    type McpServerConfig,
    type PushMethodName,
    PushMethods,
    type PushParams,
    parseImCwd,
    type RpcRequest,
    type RpcResponse,
    type RpcValidationErrorData,
    type RpcValidationIssue,
    type SessionEventsGetResult,
    type SessionId,
    type SidecarCapabilities,
    type SkillDiagnosticEntry,
    type SupportedLocale,
    WORKSPACE_ANY,
    type WorkspaceAssociationKey,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { loadAgents } from "../agents/loadAgents.ts";
import type { AgentDefinition } from "../agents/types.ts";
import { viewUserContent } from "../attachments/userMessageView.ts";
import type { ChannelBindStatus } from "../channels/channelBindBroker.ts";
import { ChannelBindBroker } from "../channels/channelBindBroker.ts";
import { FileChannelConfigStore } from "../channels/channelConfigStore.ts";
import { ChannelFactory } from "../channels/channelFactory.ts";
import { ConversationRouter } from "../channels/conversationRouter.ts";
import type { ImRoute, ImWorkspacePolicy } from "../channels/imWorkspacePolicy.ts";
import {
    chatPolicyKey,
    describeImChatOverrides,
    describeImPolicyRules,
    describeImPolicySources,
    normalizePolicyDocument,
    resolveChannelDefaultFromDocument,
} from "../channels/imWorkspacePolicy.ts";
import { ImWorkspacePolicyStore } from "../channels/imWorkspacePolicyStore.ts";
import { DefaultChannelContext } from "../channels/ingress.ts";
import type { ChannelConfig } from "../channels/registry.ts";
import { ChannelRegistry } from "../channels/registry.ts";
import type { ChannelContext, Logger } from "../channels/types.ts";
import { makeImSessionsRoot } from "../channels/virtualWorkspace.ts";
import { defaultAgentDirs } from "../config/agentDirs.ts";
import {
    defaultSkillDirs,
    extensionSkillDirInputs,
    type ResolvedCompaction,
    type ResolvedTacoConfig,
    readGlobalConfig,
    resolveConfig,
    type SkillDirInput,
    validateCommandPermissions,
} from "../config/config.ts";
import { tacoHome } from "../config/tacoHome.ts";
import { activateExtensions } from "../extensions/activation.ts";
import type { ExtensionRegistry, WorkspaceExtensionSet } from "../extensions/index.ts";
import { harnessContext } from "../lib/harnessContext.ts";
import { createLogger } from "../lib/logger.ts";
import { discoverMcpTools } from "../mcp/mcpToolProvider.ts";
import { PlanPushAdapter } from "../plan/planPushAdapter.ts";
import { DefaultDeferredToolRegistry } from "../runtime/harness/deferredToolRegistry.ts";
import { SlashNormalizedExecutionEnv } from "../runtime/harness/slashNormalizedEnv.ts";
import { resolveProvider, resolveProviderEndpoint } from "../runtime/models/modelRegistry.ts";
import type { ProviderKeyStore } from "../runtime/models/providerKeyStore.ts";
import type { ImageContent, TextContent, ThinkingLevel } from "../runtime/pi/types.ts";
import { loadSourcedSkills } from "../runtime/pi/values.ts";
import { resourceRoot } from "../runtime/runtimeResources.ts";
import type {
    ChannelControl,
    ImPolicyControl,
    JobsControl,
    ServerRpcSurface,
    WorkspaceAssociationsControl,
} from "../runtime/serverRpcSurface.ts";
import { WorkspaceRuntime } from "../runtime/workspace.ts";
import { dedupeSkillsByNameWithDuplicates } from "../skills/dedupeSkills.ts";
import {
    checkSkillFrontmatter,
    logSkillDiagnostics,
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
} from "../skills/skillDiagnostics.ts";
import {
    clearSkillFrontmatterCache,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../skills/skillFrontmatter.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import { TaskPushAdapter } from "../tasks/taskPushAdapter.ts";
import { configToolCandidates } from "../tools/configCandidates.ts";
import { sessionHistoryToolCandidates } from "../tools/sessionSearch.ts";
import {
    associationAffectsWorkspace,
    WorkspaceAssociationStore,
} from "../workspace/associationStore.ts";
import { createWorkspaceScope, type WorkspaceScope } from "../workspace/workspaceScope.ts";
import { type ChannelControlSurface, createChannelControl } from "./channelControl.ts";
import { ClientSinkRegistry } from "./clientSinkRegistry.ts";
import { CommandIdempotencyGate } from "./commandIdempotency.ts";
import { CompactionPushAdapter } from "./compactionPushAdapter.ts";
import { ConnectionServer } from "./connectionServer.ts";
import type { DurablePushLog } from "./durablePushLog.ts";
import { resolveImExecutionCwd } from "./imExecutionCwd.ts";
import { getRegisteredMethod, listRegisteredMethods, type MethodCtx } from "./methodRegistry.ts";
import { registerBuiltinMethods } from "./methods.ts";
import {
    makePushFrame,
    normalizeMessageUpdate,
    redactCommandPermissionRequest,
    toToolCallPush,
} from "./push.ts";
import {
    err,
    getTurnKey,
    normalizeError,
    ok,
    toCommandOutcome,
    withRequestId,
} from "./rpcResponse.ts";
import { SessionEventLog } from "./sessionEventLog.ts";
import { StdioTransport } from "./stdioTransport.ts";
import type { Transport } from "./transport.ts";
import { parseJsonPointer } from "./validation.ts";
import { WorkspaceRegistry } from "./workspaceRegistry.ts";

const log = createLogger("sidecar");

const PUSH_METHOD_NAMES = Object.values(PushMethods).sort();

export interface SidecarServerOptions {
    /** Session persistence root; default $TACO_HOME/sessions (default ~/.taco/sessions) */
    sessionsRoot?: string;
    /** Default model id */
    defaultModel?: string;
    /** Default provider id (scopes defaultModel lookup to this provider) */
    defaultProvider?: string;
    /** System prompt */
    systemPrompt?: string;
    /** Default thinking level for new workspaces; can be overridden per-call via session.create/attach */
    defaultThinkingLevel?: ThinkingLevel;
    /**
     * Resolved compaction policy (non-optional defaults filled in). Passed
     * through to WorkspaceRuntime -> AttachedSessionOptions as the
     * auto-compaction threshold.
     */
    compaction?: ResolvedCompaction;
    /** Enable user-level memory. `undefined` = default (enabled). Passed to WorkspaceRuntime. */
    memoryEnabled?: boolean;
    /**
     * Project-context instructions injection (CLAUDE.md / AGENTS.md /
     * DESIGN.md). Threaded into every `WorkspaceRuntime` constructed
     * by `buildWorkspace`. Hot-reloadable via `settings.write` →
     * `refreshConfiguration`.
     *
     * Without this being passed at construction, every workspace falls
     * back to `mergeWithDefaults()` and the user's `taco.json
     * instructions` block is silently ignored (pre-fix bug; the
     * WorkspaceRuntime `instructionsConfig` field stayed `undefined`
     * for the entire process lifetime).
     */
    instructionsConfig?: InstructionsConfig;
    /** Disk tail for sequenced pushes, owned by the daemon's single event log. */
    pushLog?: DurablePushLog;
    /** Process-wide extension registry — shared across all workspaces */
    extensionRegistry?: ExtensionRegistry;
    /**
     * Process-wide API key store. Required.
     *  - every workspace's ModelRegistry subscribes to key-change notifications
     *  - the `settings.write` handler calls `providerKeyStore.update()` to trigger hot reload
     * Production entry points (e.g. `src/index.ts`) construct a new
     * `ProviderKeyStore()` with the API keys loaded from `taco.json`.
     * Tests construct a fresh `ProviderKeyStore({})` and seed it explicitly.
     */
    providerKeyStore: ProviderKeyStore;
    /** Re-resolve disk configuration with the entry point's CLI overrides. */
    resolveConfig?: () => ResolvedTacoConfig;
    /** Custom provider config (parsed at startup from taco.json), injected into every workspace's catalog */
    customProviders?: readonly CustomProviderConfig[];
    /** User-added models for built-in providers (taco.json providerExtraModels), merged into every workspace's catalog. */
    providerExtraModels?: Record<string, CustomModelEntry[]>;
    /** Static model ids hidden on built-in providers (taco.json providerHiddenModels), filtered out of every workspace's catalog. */
    providerHiddenModels?: Record<string, string[]>;
    /** MCP servers whose tools become dynamic-tool candidates (parsed at startup from taco.json). */
    mcpServers?: readonly McpServerConfig[];
    /** Maximum number of settled command outcomes retained; values below 1 clamp to 1. */
    commandRecordLimit?: number;
    /**
     * How long a command outcome stays eligible for idempotent replay
     * (retry window). Records older than this are treated as absent so a
     * retry re-executes the command. In-flight records are reclaimed too,
     * which bounds the map against a never-settling RPC.
     */
    commandRecordTtlMs?: number;
    /** Monotonic clock for TTL decisions. Defaults to performance.now(). */
    now?: () => number;
    /** Optional workspace registry injection for isolated server tests. */
    workspaceRegistry?: WorkspaceRegistry;
    /** Transport instance; defaults to StdioTransport. */
    transport?: Transport;
    /** Channel configs for IM channels; Channel instances are resolved from manifest.name via ChannelFactory. */
    channels?: readonly ChannelConfig[];
    /** Scheduler control shared by client and background RPCs. */
    jobs?: JobsControl;
    /** Optional router injection for tests and daemon startup. */
    conversationRouter?: ConversationRouter;
    /** Delivers runtime pushes to initialized daemon connections. */
    clientSinkRegistry?: ClientSinkRegistry;
}

interface RuntimePushEvent {
    sessionId: SessionId;
    event?: unknown;
    error?: unknown;
}

/**
 * Per-locale notice sent once per IM workspace when local tools are first
 * enabled. Keyed by the client's `uiLocale` from `initialize`. Anything not in
 * the table (including undefined locale before handshake) falls back to
 * English. Adding a new locale is one map entry plus one translation.
 */
const IM_TOOLS_ENABLED_NOTICES: Readonly<Record<SupportedLocale, string>> = {
    en: "Local tools are enabled for this chat. Commands run inside the authorised directory and are gated by the admin rule set.",
    zh: "此对话已启用本地工具。命令将在已授权目录执行,并受管理员规则限制。",
};

function imToolsEnabledNotice(locale: SupportedLocale | undefined): string {
    return IM_TOOLS_ENABLED_NOTICES[locale ?? "en"] ?? IM_TOOLS_ENABLED_NOTICES.en;
}

type ImPermissionNotice = "requested" | "approved" | "timeout" | "denied";

/**
 * Command-approval notices sent to IM peers. Keyed by the same desktop
 * `uiLocale` as IM_TOOLS_ENABLED_NOTICES — the peer has no locale of its own.
 * The `requested` text ends at the session label; the caller appends the id.
 */
const IM_PERMISSION_NOTICES: Readonly<
    Record<ImPermissionNotice, Readonly<Record<SupportedLocale, string>>>
> = {
    requested: {
        en: "This command needs human approval. Open the notification in the Taco desktop app and handle it in this conversation; the command will not run while waiting. Session: ",
        zh: "此命令需要人工审批。请在 Taco 桌面端打开通知，进入此会话处理；等待期间命令不会执行。会话：",
    },
    approved: {
        en: "The command was approved and will continue.",
        zh: "命令已获批准，继续执行。",
    },
    timeout: {
        en: "Command approval timed out; the command was not run. Open this conversation in the desktop app and try again.",
        zh: "命令审批已超时，未执行。请在桌面端打开此会话后重试。",
    },
    denied: {
        en: "Command approval was rejected or cancelled; the command was not run.",
        zh: "命令审批已拒绝或取消，未执行。",
    },
};

function imPermissionNotice(kind: ImPermissionNotice, locale: SupportedLocale | undefined): string {
    return IM_PERMISSION_NOTICES[kind][locale ?? "en"] ?? IM_PERMISSION_NOTICES[kind].en;
}

/** How long a deleted session's tombstone stays in the replay log. */
const TOMBSTONE_TTL_MS = 60_000;

export class SidecarServer implements ServerRpcSurface {
    /**
     * Replay ring for sequenced pushes. The disk tail behind it —
     * `hydrateSessionEvents` reads it back after a restart so client cursors
     * keep seeing contiguous seqs — is injected rather than constructed here:
     * a daemon runs several servers and they must share one writer per stream
     * file. See `DurablePushLog`'s "One writer per stream".
     */
    private readonly sessionEvents: SessionEventLog;
    /** Live workspace table + cold-start single-flight — see workspaceRegistry.ts. */
    private readonly workspaces: WorkspaceRegistry;
    private readonly options: SidecarServerOptions & { resolveConfig: () => ResolvedTacoConfig };
    /** Command-idempotency cache + turn gate — see commandIdempotency.ts. */
    private readonly idempotency: CommandIdempotencyGate;
    /** IM workspace policy store — admin-granted, survives channel unbind. */
    readonly imPolicyStore: ImWorkspacePolicyStore;
    /**
     * Workspace directory associations — the directories a workspace may
     * reach beyond its own root. Read on every use (the store is uncached),
     * so a change made by one client reaches every other workspace in the
     * process without a rebuild.
     */
    readonly associationStore: WorkspaceAssociationStore;
    private readonly clientContext = new AsyncLocalStorage<ClientCapabilities>();

    private get requestUiLocale(): SupportedLocale | undefined {
        return this.clientContext.getStore()?.uiLocale;
    }
    /**
     * Snapshot of the channel ids that actually started during the most
     * recent `start()`. The `initialize` response surfaces this set so the
     * client can gate channel-aware UI on it. Empty until `start()` runs.
     */
    private startedChannelIds: readonly string[] = [];
    readonly extensionRegistry?: ExtensionRegistry;
    /**
     * Currently active custom provider set — initialized at startup from
     * options.customProviders; replaced at runtime via `setCustomProviders`
     * (after settings.write changes customProviders). Existing workspaces'
     * catalogs are reconciled live (add/remove); new workspaces read the
     * latest value in ensureWorkspace.
     */
    private customProviders: readonly CustomProviderConfig[] = [];
    /**
     * User-added models for built-in providers — same lifecycle as
     * customProviders: startup from options, runtime replacement via
     * `setProviderExtraModels` (after settings.write), read by buildWorkspace.
     */
    private providerExtraModels: Record<string, CustomModelEntry[]> = {};
    /** Same lifecycle as providerExtraModels; hidden static model ids. */
    private providerHiddenModels: Record<string, string[]> = {};
    /**
     * `instructionsConfig` captured at construction. Hot updates go
     * through `refreshInstructions()` on each SidecarServer; this field
     * is read by `buildWorkspace()` when a new workspace is built.
     */
    private instructionsConfig?: InstructionsConfig;
    /** Currently active MCP server set — see customProviders for lifecycle notes. */
    private mcpServers: readonly McpServerConfig[] = [];
    readonly providerKeyStore: ProviderKeyStore;
    /** Scheduler controller — exposed to `jobs.*` handlers via ServerRpcSurface.
     *  Mutable via `setJobsControl()` so the daemon can mount the controller
     *  after the resident's `start()` finishes (the controller's
     *  Scheduler/JobStore depend on the resident, so it's a chicken/egg). */
    private _jobs: JobsControl | undefined;
    get jobs(): JobsControl | undefined {
        return this._jobs;
    }
    setJobsControl(next: JobsControl | undefined): void {
        this._jobs = next;
    }
    readonly channelRegistry: ChannelRegistry;
    readonly channelBindBroker: ChannelBindBroker;
    /** Resolved by the ctor after the broker + router exist. */
    private readonly channelFactory: ChannelFactory;
    private conversationRouter?: ConversationRouter;
    /** Router inspection for integration tests. */
    get conversationRouterView(): ConversationRouter | undefined {
        return this.conversationRouter;
    }
    /** Process-level fan-out registry for all shared workspace pushes. */
    private readonly clientSinkRegistry: ClientSinkRegistry;
    /** taco.json channel instances, kept so channels.list can report the
     *  configured set independently of which ones actually started. */
    private channelConfigs: readonly ChannelConfig[] = [];
    private failedChannels: readonly { channelId: string; error: string }[] = [];
    /** IM channel control surface — see `channelControl.ts`. */
    private readonly channelControl: ChannelControlSurface;
    private transport?: Transport;
    private connection?: ConnectionServer;
    /**
     * True once stop() has run. Used by buildWorkspace to drop a workspace it
     * was constructing when shutdown raced in — without this the worker would
     * silently publish a ws that no caller will ever see (the registry was
     * cleared). Connection handshake state belongs to ConnectionServer.
     */
    private stopped = false;
    private configSnapshot?: ResolvedTacoConfig;

    /** Lazily creates a StdioTransport if transport is not set (for tests that call server methods without start()). */
    private getTransport(): Transport {
        return this.transport ?? new StdioTransport();
    }
    /**
     * Compaction state machine + push frame assembly — translates the
     * CompactionController lifecycle pair (`taco_compaction_start` /
     * `taco_compaction_end`) into CompactionStarted / CompactionFinished named
     * pushes. isCompressing / awaitCompactionEnd are forwarded to RPC handlers
     * (session.prompt / steer). See adapter.
     */
    private readonly compactionAdapter = new CompactionPushAdapter(
        (method, workspace, session, params) => this.emitPush(method, workspace, session, params),
    );

    /**
     * Whether the given (cwd, sessionId) is currently compacting.
     * Forwarded to CompactionPushAdapter, kept as a ServerRpcSurface public API.
     */
    isCompressing(cwd: WorkspaceId, sessionId: SessionId): boolean {
        return this.compactionAdapter.isCompressing(cwd, sessionId);
    }

    /**
     * Wait for the current compaction to finish. Forwarded to
     * CompactionPushAdapter, kept as a ServerRpcSurface public API.
     */
    awaitCompactionEnd(cwd: WorkspaceId, sessionId: SessionId, timeoutMs = 1500): Promise<boolean> {
        return this.compactionAdapter.awaitCompactionEnd(cwd, sessionId, timeoutMs);
    }

    /**
     * `ServerRpcSurface.dispatchRpc` — routes the request through the in-process
     * handler registry, skipping NDJSON parse/write. See
     * `ServerRpcSurface.dispatchRpc` JSDoc.
     */
    dispatchRpc(req: RpcRequest): Promise<RpcResponse> {
        return this.handleRpcRequest(req);
    }

    dispatchClientRpc(req: RpcRequest, capabilities: ClientCapabilities): Promise<RpcResponse> {
        return this.clientContext.run(capabilities, () => this.handleRpcRequest(req));
    }

    lookupRoute(workspace: string): { sessionId: string } | undefined {
        return this.conversationRouter?.lookupByWorkspace(workspace);
    }

    /** Authoritative capability advertisement returned by `initialize`. */
    getServerCapabilities(): SidecarCapabilities {
        return {
            methods: listRegisteredMethods(),
            pushes: PUSH_METHOD_NAMES,
            channels: this.startedChannelIds,
        };
    }

    constructor(options: SidecarServerOptions) {
        const resolver =
            options.resolveConfig ??
            (() =>
                resolveConfig({
                    defaultModel: options.defaultModel,
                    defaultProvider: options.defaultProvider,
                    systemPrompt: options.systemPrompt,
                    thinkingLevel: options.defaultThinkingLevel,
                    compaction: options.compaction,
                    memoryEnabled: options.memoryEnabled,
                    instructions: options.instructionsConfig,
                }));
        const config = resolver();
        this.options = {
            ...config,
            ...options,
            defaultModel: options.defaultModel ?? config.defaultModel,
            defaultProvider: options.defaultProvider ?? config.defaultProvider,
            systemPrompt: options.systemPrompt ?? config.systemPrompt,
            compaction: options.compaction ?? config.compaction,
            memoryEnabled: options.memoryEnabled ?? config.memoryEnabled,
            defaultThinkingLevel: options.defaultThinkingLevel ?? config.defaultThinkingLevel,
            resolveConfig: resolver,
        };
        this.configSnapshot = config;
        this.workspaces =
            options.workspaceRegistry ?? new WorkspaceRegistry((cwd) => this.buildWorkspace(cwd));
        this.idempotency = new CommandIdempotencyGate({
            ttlMs: options.commandRecordTtlMs,
            limit: options.commandRecordLimit,
            now: options.now,
        });
        this.extensionRegistry = options.extensionRegistry;
        this.providerKeyStore = options.providerKeyStore;
        // Embedded hosts may seed credentials directly; only configured initial keys override them.
        this.providerKeyStore.update(
            Object.fromEntries(Object.entries(config.apiKeys).filter(([, value]) => value !== "")),
        );
        this._jobs = options.jobs;
        this.customProviders = options.customProviders ?? config.customProviders ?? [];
        this.providerExtraModels = options.providerExtraModels ?? config.providerExtraModels ?? {};
        this.providerHiddenModels =
            options.providerHiddenModels ?? config.providerHiddenModels ?? {};
        // instructionsConfig is captured at construction so every
        // workspace built by buildWorkspace() sees the same value. The
        // existing refreshInstructions() hot-reload path stays
        // unchanged — it updates already-built workspaces.
        this.instructionsConfig = options.instructionsConfig ?? config.instructions;
        this.mcpServers = options.mcpServers ?? config.mcpServers ?? [];
        this.imPolicyStore = new ImWorkspacePolicyStore();
        this.associationStore = new WorkspaceAssociationStore();
        this.sessionEvents = new SessionEventLog(512, options.pushLog);
        this.clientSinkRegistry = options.clientSinkRegistry ?? new ClientSinkRegistry();
        this.channelRegistry = new ChannelRegistry();
        this.channelBindBroker = new ChannelBindBroker();
        this.conversationRouter = options.conversationRouter;
        this.channelFactory = new ChannelFactory({
            broker: this.channelBindBroker,
            // Resolved at push time: the router only knows a route once the
            // peer's first message has created the session.
            //
            // findRouteBySessionId already returns the full (channelId,
            // peerId, chatId) triple; channels consume the slice they need
            // (wechat → peerId, wecom → chatId). Keeping one resolver avoids
            // the two overlapping seams a separate resolvePeer would create.
            resolveRoute: (sessionId) => this.conversationRouter?.findRouteBySessionId(sessionId),
            // Broadcast a workspace-dimensioned notice (e.g. the policy
            // interrupt notice) to every peer routed through a channel.
            listPeers: (channelId) =>
                this.conversationRouter?.listAll(channelId).map((e) => e.peerId) ?? [],
        });
        // Explicitly register all builtin method handlers instead of relying on module-level side-effect imports.
        this.channelControl = createChannelControl({
            channelRegistry: this.channelRegistry,
            channelBindBroker: this.channelBindBroker,
            getConversationRouter: () => this.conversationRouter,
            getChannelConfigs: () => this.channelConfigs,
            getFailedChannels: () => this.failedChannels,
        });
        this.channels = this.channelControl.channels;
        registerBuiltinMethods();
    }

    /** For method handlers / tests — list cwd of currently active workspaces */
    workspaceIds(): WorkspaceId[] {
        return this.workspaces.keys();
    }

    getSessionEvents(
        workspace: WorkspaceId,
        sessionId: SessionId,
        afterSeq: number,
    ): SessionEventsGetResult {
        return this.sessionEvents.replay(workspace, sessionId, afterSeq);
    }

    getSessionLastSeq(workspace: WorkspaceId, sessionId: SessionId): number {
        return this.sessionEvents.lastSeq(workspace, sessionId);
    }

    clearSessionEvents(workspace: WorkspaceId, sessionId: SessionId): void {
        this.sessionEvents.clearSession(workspace, sessionId);
    }

    hydrateSessionEvents(workspace: WorkspaceId, sessionId: SessionId): Promise<void> {
        return this.sessionEvents.hydrate(workspace, sessionId);
    }

    /** Start the service — read stdin (NDJSON), write push events to stdout */
    async start(
        transport: Transport = this.options.transport ?? new StdioTransport(),
        channelConfigs: readonly ChannelConfig[] = this.options.channels ?? [],
    ): Promise<void> {
        this.stopped = false;
        this.workspaces.start();
        this.transport = transport;
        this.connection = new ConnectionServer(this, transport, this.clientSinkRegistry);
        await this.connection.start();

        this.conversationRouter ??= await ConversationRouter.load(tacoHome());
        this.conversationRouter.on("conversation", this.onRouterConversation);
        this.channelConfigs = channelConfigs;
        this.channelBindBroker.on("status", this.onBrokerStatus);
        const startedChannelIds: string[] = [];
        if (channelConfigs.length > 0) {
            const result = await this.channelRegistry.loadAndStart(
                channelConfigs,
                async (name) => this.channelFactory.create(name),
                (id, config) => this.buildChannelContext(id, config),
            );
            this.failedChannels = result.failed;
            for (const f of result.failed) {
                log.error(`channel ${f.channelId} failed to start: ${f.error}`);
            }
            for (const id of result.started) {
                startedChannelIds.push(id);
            }
        }
        this.startedChannelIds = startedChannelIds;

        this.idempotency.startSweeper();
    }

    /** Named refs for stop() to off() — see start() for why this matters. */
    private readonly onRouterConversation = () => this.broadcastConversationsChanged();
    private readonly onBrokerStatus = (s: ChannelBindStatus) => {
        // Broker frames are the raw transition; the wire entry adds the
        // config-derived name and the on-disk configured flag. Building it
        // here keeps the push payload identical to `channels.list` output —
        // the client replaces the entry wholesale on applyChannelStatus.
        this.broadcastChannelStatus(this.channelControl.toStatusEntry(s));
    };

    /** Stop — close all harnesses held by runtimes */
    async stop(): Promise<void> {
        this.stopped = true;
        this.channelBindBroker.off("status", this.onBrokerStatus);
        this.conversationRouter?.off("conversation", this.onRouterConversation);
        this.idempotency.stop();
        const resources = disposeInOrder([
            () => this.connection?.stop(),
            () => {
                this.channelBindBroker.cancelAll();
            },
            () => this.channelRegistry.stopAll(),
            () => this.workspaces.stop(),
        ]);
        // Finish resetting connection state even if a resource rejects during teardown.
        let failure: unknown;
        try {
            await resources;
        } catch (error) {
            failure = error;
        }
        // Drain the push tail BEFORE dropping the ring: a graceful restart is
        // exactly when seq continuity matters, and the buffered window would
        // otherwise be lost — leaving the restarted server to hydrate a seq
        // lower than the client's cursor and discard live frames as duplicates.
        // Best-effort: a failed flush degrades to the snapshot-recovery path,
        // so it must not block shutdown.
        await this.sessionEvents.flushDurable().catch((err: unknown) => {
            log.warn(`push tail flush on shutdown failed: ${String(err)}`);
        });
        this.sessionEvents.clear();
        this.startedChannelIds = [];
        if (failure) throw failure;
    }

    /** Builds a ChannelContext for the given channelId.
     *  @throws if called before start() (conversationRouter not initialized). */
    buildChannelContext(channelId: string, config: Record<string, unknown> = {}): ChannelContext {
        if (!this.conversationRouter) {
            throw new Error("conversationRouter not initialized — call start() first");
        }
        return new DefaultChannelContext(
            channelId,
            this,
            this.conversationRouter,
            new FileChannelConfigStore(channelId, config),
            this.channelLogger(channelId),
        );
    }

    /** Channel logger — scope carries the channelId; satisfies channels' Logger. */
    private channelLogger(channelId: string): Logger {
        return createLogger(`channel:${channelId}`);
    }

    // ─────────── internals ───────────

    /**
     * Handles an RpcRequest via the same path as NDJSON dispatch — handler
     * registry + middleware + RpcHandlerError -> RpcResponse.error translation
     * are all preserved. Used by in-process tools that self-RPC (see
     * `RpcDispatch.call` on the sidecar side) to avoid splitting RPC across
     * processes. No `not_initialized` gate here: in-process callers have no
     * handshake to perform. ConnectionServer gates both stdio and socket clients.
     */
    async handleRpcRequest(req: RpcRequest): Promise<RpcResponse> {
        const reg = getRegisteredMethod(req.method);
        if (!reg) {
            return err(req.id, ErrorCodes.UnknownMethod, `unknown method: ${req.method}`);
        }

        // Schema validation — only when the registration declared a typebox
        // schema. Failures short-circuit with `invalid_params` carrying the
        // JSON-pointer paths so clients and logs can diagnose the offending
        // field without exposing the raw request payload.
        if (reg.schema) {
            const errors = Value.Errors(reg.schema, req.params);
            if (errors.length > 0) {
                const issues: RpcValidationIssue[] = errors.map((e) => ({
                    path: parseJsonPointer(e.instancePath),
                    message: e.message ?? "validation error",
                    schema: e.schemaPath,
                }));
                return err(req.id, ErrorCodes.InvalidParams, "parameter validation failed", {
                    issues,
                } satisfies RpcValidationErrorData);
            }
        }

        if (!reg.options.command || req.commandId === undefined) {
            return await this.executeRpcRequest(req, reg);
        }
        if (typeof req.commandId !== "string" || req.commandId.length === 0) {
            return err(req.id, ErrorCodes.InvalidParams, "commandId must be a non-empty string");
        }

        // Key/fingerprint extraction stays here (the gate knows nothing
        // about RpcRequest); error frames are minted here too — their
        // message strings are wire contract asserted verbatim by
        // commandIdempotency.test.ts.
        const key = `${req.method}\u0000${req.commandId}`;
        const fingerprint = JSON.stringify(req.params ?? null);
        const turnKey = reg.options.turnStart ? getTurnKey(req.params) : undefined;
        const result = this.idempotency.run(key, fingerprint, turnKey, () =>
            this.executeRpcRequest(req, reg).then(toCommandOutcome),
        );
        if (result === "conflict") {
            return err(
                req.id,
                ErrorCodes.CommandIdConflict,
                "commandId was already used with different request parameters",
            );
        }
        if (result === "busy") {
            return err(
                req.id,
                ErrorCodes.SessionBusy,
                "a turn command is already active for this session",
            );
        }
        return withRequestId(req.id, await result);
    }

    private async executeRpcRequest(
        req: RpcRequest,
        reg: NonNullable<ReturnType<typeof getRegisteredMethod>>,
    ): Promise<RpcResponse> {
        try {
            let workspace: WorkspaceRuntime | undefined;
            let cwd: WorkspaceId = WORKSPACE_ANY;
            if (reg.options.workspaceParam) {
                const params = (req.params ?? {}) as Record<string, unknown>;
                const route = params[reg.options.workspaceParam];
                if (typeof route !== "string" || route.length === 0) {
                    return err(
                        req.id,
                        ErrorCodes.InvalidParams,
                        `missing required field: ${reg.options.workspaceParam}`,
                    );
                }
                cwd = asWorkspaceId(route);
            }
            if (reg.ensureWorkspace) {
                const params = (req.params ?? {}) as { workspace?: WorkspaceId };
                if (typeof params.workspace !== "string" || params.workspace.length === 0) {
                    return err(
                        req.id,
                        ErrorCodes.InvalidParams,
                        "missing required field: workspace",
                    );
                }
                cwd = params.workspace;
                // ensureWorkspace always resolves a runtime (failures throw, caught by outer normalizeError)
                workspace = await this.ensureWorkspace(cwd);
            }
            const ctx: MethodCtx<unknown> = {
                id: req.id,
                // when ensureWorkspace=false, workspace is undefined — handler handles it itself
                workspace: workspace as WorkspaceRuntime,
                cwd,
                server: this,
                params: req.params,
            };
            const result = await reg.handler(ctx);
            return ok(req.id, result);
        } catch (e) {
            return normalizeError(req.id, e);
        }
    }

    /**
     * Resolve cwd to workspace construction inputs. IM workspaces keep the
     * im:// URL as key and route to an isolated per-channel scratch root;
     * fs workspaces pass through with fs tools enabled.
     */
    private resolveWorkspacePaths(key: WorkspaceId): {
        scope: WorkspaceScope;
        sessionsRoot?: string;
        imPolicy?: ImWorkspacePolicy;
    } {
        const route = parseImCwd(key);
        if (!route)
            return { scope: createWorkspaceScope(key), sessionsRoot: this.options.sessionsRoot };
        const sessionsRoot = makeImSessionsRoot(tacoHome(), route.channelId);
        const sessionCwd = join(sessionsRoot, "scratch");
        mkdirSync(sessionCwd, { recursive: true });
        this.channelRegistry.trackWorkspace(route.channelId, key);
        const imPolicy = this.imPolicyStore.resolve(route);
        const exec = resolveImExecutionCwd({ sessionsRoot, route, policy: imPolicy });
        if (exec.warning) log.warn(exec.warning);
        if (
            (imPolicy.tools.shell === "allow" || imPolicy.tools.fsTools === "allow") &&
            exec.shared
        ) {
            log.warn(
                `IM chat ${key} now has local tools but shares ${exec.executionCwd} with every other ` +
                    `chat on channel ${route.channelId} — set executionDir to per-chat or custom to isolate it.`,
            );
        }
        return {
            scope: createWorkspaceScope(key, sessionCwd, exec.executionCwd),
            sessionsRoot,
            imPolicy,
        };
    }

    /**
     * Scan skill directories and return the deduped, frontmatter-stamped
     * skill list (sources tagged for `skills.list` RPC and SkillsPane).
     * Extracted from `loadWorkspaceAssets` so hot reload can re-run this
     * exact path instead of a second, drifting copy.
     *
     * Sources come from `defaultSkillDirs` in priority order (.taco/skills
     * → $TACO_HOME/skills → ~/.claude/skills → ~/.pi/skills → builtin).
     */
    private async loadSkills(
        fsCwd: string,
    ): Promise<{ skills: TacoSkill[]; diagnostics: SkillDiagnosticEntry[] }> {
        // Clear first, not after: an edited SKILL.md's frontmatter
        // (runAs/inlineOnly/allowedTools/model) must not keep serving a
        // pre-edit value from a previous call's cache. Clearing an empty
        // map (the cold-start case) is a no-op, so cold start and reload
        // run the identical sequence rather than diverging.
        clearSkillFrontmatterCache();

        // SlashNormalizedExecutionEnv wraps NodeExecutionEnv so listDir /
        // fileInfo / canonicalPath return forward-slash paths even on
        // Windows. pi-agent-core's `relativeEnvPath` compares with
        // `path.startsWith(root + "/")` and falls back to the unchanged
        // absolute path when separators don't match — on Windows that
        // makes `ignore` throw "path should be a path.relative()'d
        // string". Combined with `defaultSkillDirs` (also forward-slash
        // normalized) both sides of the comparison agree.
        const skillEnv = new SlashNormalizedExecutionEnv({ cwd: fsCwd });
        // Enabled builtins may ship their own skill dirs (BuiltinManifest
        // .skillDirs). They are appended after defaultSkillDirs so a user skill
        // of the same name still wins by first-wins, and a disabled builtin
        // contributes nothing — its dirs are never collected (see
        // registerBuiltinExtensions).
        const skillDirs: SkillDirInput[] = [
            ...defaultSkillDirs(fsCwd),
            ...extensionSkillDirInputs(this.extensionRegistry?.extensionSkillDirs() ?? []),
        ];
        const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
            skillEnv,
            skillDirs,
            (skill, source): TacoSkill => ({ ...skill, source }),
            harnessContext,
        );
        // pi's loadSourcedSkills does not dedupe internally; defaultSkillDirs
        // places .taco/skills first and builtin last, so dedupeSkillsByName
        // gives ".taco wins, builtin falls back" first-match semantics.
        const deduped = dedupeSkillsByNameWithDuplicates(loaded.skills.map((entry) => entry.skill));
        const skills = deduped.kept;
        preloadSkillFrontmatter(skills);
        // Stamp frontmatter-only fields (currently: inlineOnly, whenToUse) onto
        // each TacoSkill so skills.list can surface them. preloadSkillFrontmatter
        // must run first — readSkillFrontmatter returns from the cache. The
        // same pass lints the taco-private keys pi ignores, so a malformed
        // runAs/inlineOnly/allowedTools/whenToUse surfaces as a diagnostic here
        // rather than as a tool error at call time.
        const frontmatterDiagnostics: SkillDiagnosticEntry[] = [];
        for (const s of skills) {
            const fm = readSkillFrontmatter(s.filePath);
            if (fm.inlineOnly === true) {
                (s as TacoSkill).inlineOnly = true;
            }
            // typeof guard, not `!== undefined`: raw YAML yields null for an
            // empty `whenToUse:` and numbers/booleans for unquoted values —
            // `.trim()` on any of them would throw and abort the whole loop.
            if (typeof fm.whenToUse === "string" && fm.whenToUse.trim().length > 0) {
                (s as TacoSkill).whenToUse = fm.whenToUse.trim();
            }
            frontmatterDiagnostics.push(...checkSkillFrontmatter(fm, s.filePath));
        }
        // Logs stay: they are the only channel for headless / IM runs with no
        // client to read `skills.list`. The returned copy is additional, not a
        // replacement. The level contract — never warn, always info — lives in
        // logSkillDiagnostics so a single test can guard the toast-surfacing
        // contract: warn lines become desktop toasts on every boot and every
        // hot reload, which we don't want for known-shape skill hygiene
        // problems. Users still see them by opening the skills pane.
        const diagnostics = [
            ...mapLoaderDiagnostics(loaded.diagnostics),
            ...mapDuplicateDiagnostics(deduped.duplicates),
            ...frontmatterDiagnostics,
        ];
        logSkillDiagnostics(
            {
                loader: diagnostics,
                frontmatter: frontmatterDiagnostics,
                duplicates: mapDuplicateDiagnostics(deduped.duplicates),
            },
            log,
        );
        return { skills, diagnostics };
    }

    /**
     * Load workspace-scoped assets (skills, agents, extensions). All touch the
     * filesystem, so they are awaited before the synchronous WorkspaceRuntime
     * constructor.
     */
    private async loadWorkspaceAssets(scope: WorkspaceScope): Promise<{
        skills: TacoSkill[];
        skillDiagnostics: SkillDiagnosticEntry[];
        agents: AgentDefinition[];
        extensions?: Readonly<WorkspaceExtensionSet>;
    }> {
        const { skills, diagnostics: skillDiagnostics } = await this.loadSkills(scope.executionCwd);

        // Load agents (builtin + user-defined). Same pattern as skills:
        // file I/O is awaited here.
        const builtinDir = join(resourceRoot(), "agents", "builtin");
        const agents = await loadAgents({
            builtinDir,
            userDirs: defaultAgentDirs(scope.executionCwd),
        });

        // Activate extensions: workspace activators are called here and
        // produce a frozen WorkspaceExtensionSet.
        const extensions = await activateExtensions(this.extensionRegistry, {
            cwd: scope.executionCwd,
            isIm: scope.kind === "im",
        });

        return { skills, skillDiagnostics, agents, extensions };
    }

    /** For handlers / method layer — lazily created on first access */
    async ensureWorkspace(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        if (this.stopped) throw new Error("sidecar is stopped");
        await this.refreshConfiguration();
        return this.workspaces.ensure(cwd);
    }

    /** Apply effective configuration once; construction-only settings wait for a new workspace. */
    async refreshConfiguration(): Promise<void> {
        let next: ResolvedTacoConfig;
        try {
            next = this.options.resolveConfig();
        } catch (error) {
            log.warn(
                "config refresh failed; retaining the last valid runtime configuration",
                String(error),
            );
            return;
        }
        const previous = this.configSnapshot;
        const changed = (key: keyof ResolvedTacoConfig) =>
            JSON.stringify(next[key]) !== JSON.stringify(previous?.[key]);
        const catalogChanged =
            changed("customProviders") ||
            changed("providerExtraModels") ||
            changed("providerHiddenModels");
        if (changed("apiKeys")) {
            const removed = Object.fromEntries(
                Object.keys(previous?.apiKeys ?? {})
                    .filter((key) => !(key in next.apiKeys))
                    .map((key) => [key, ""]),
            );
            this.providerKeyStore.update({ ...removed, ...next.apiKeys });
        }
        if (changed("customProviders")) this.setCustomProviders(next.customProviders ?? []);
        if (changed("providerExtraModels") || changed("providerHiddenModels")) {
            this.setProviderModelEdits(
                next.providerExtraModels ?? {},
                next.providerHiddenModels ?? {},
            );
        }
        // Catalog reconciliation must finish before resolving the default model.
        if (changed("defaultModel") || changed("defaultProvider") || catalogChanged) {
            this.setDefaultModel(next.defaultModel, next.defaultProvider);
        }
        if (changed("instructions")) this.refreshInstructions(next.instructions);
        if (changed("compaction")) {
            this.options.compaction = next.compaction;
            this.invalidateCompactionCaches();
        }
        // Disposal on this path can abort unrelated turns or deadlock a turn waiting on self-RPC.
        if (changed("memoryEnabled")) this.options.memoryEnabled = next.memoryEnabled;
        if (changed("systemPrompt")) this.options.systemPrompt = next.systemPrompt;
        if (changed("defaultThinkingLevel"))
            this.options.defaultThinkingLevel = next.defaultThinkingLevel;
        if (changed("mcpServers")) this.mcpServers = next.mcpServers ?? [];
        if (changed("apiKeys") || catalogChanged) this.broadcastModelsChanged();
        this.configSnapshot = next;
    }

    private async buildWorkspace(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        const { scope, sessionsRoot, imPolicy } = this.resolveWorkspacePaths(cwd);
        const { skills, skillDiagnostics, agents, extensions } =
            await this.loadWorkspaceAssets(scope);

        // Discover MCP tools (stdio cwd defaults to the workspace dir) and build
        // the dynamic-tool registry from them. Discovery failure is isolated per
        // server and never blocks workspace startup.
        //
        // The workspace dir is only usable as a default cwd when it still
        // exists. It may not: the desktop's default workspace lives under /tmp,
        // which the OS prunes, and a workspace can be opened from history after
        // its directory was moved or deleted. Handing a missing dir to spawn
        // fails every stdio server with an ENOENT that names the command, so
        // fall back to letting the child inherit our cwd instead.
        const workspaceCwdUsable = existsSync(scope.executionCwd);
        if (!workspaceCwdUsable && this.mcpServers.length > 0) {
            log.warn(
                `workspace dir missing (${scope.executionCwd}); stdio MCP servers without an explicit cwd will inherit the sidecar's`,
            );
        }
        const mcpProvider = await discoverMcpTools({
            servers: this.mcpServers.map((s) => ({
                ...s,
                ...(s.cwd !== undefined
                    ? { cwd: s.cwd }
                    : workspaceCwdUsable
                      ? { cwd: scope.executionCwd }
                      : {}),
            })),
            log,
        });
        const toolRegistry = new DefaultDeferredToolRegistry({
            candidates: [
                ...mcpProvider.candidates(),
                ...configToolCandidates(),
                // Not offered to IM workspaces: a third party drives those, and
                // the transcripts are the user's private history.
                ...(scope.kind === "im" ? [] : sessionHistoryToolCandidates()),
            ],
            dispose: () => mcpProvider.dispose(),
        });

        // From here on, any failure must dispose mcpProvider — its stdio
        // children / HTTP sockets outlive this scope otherwise. wireWorkspacePush
        // can throw on broken channel registries; WorkspaceRuntime's ctor can
        // throw on bad config; we don't get a second chance to release the
        // provider once it leaves this function.
        let ws: WorkspaceRuntime | undefined;
        try {
            ws = new WorkspaceRuntime({
                scope,
                sessionsRoot,
                defaultModel: this.options.defaultModel,
                defaultProvider: this.options.defaultProvider,
                systemPrompt: this.options.systemPrompt,
                defaultThinkingLevel: this.options.defaultThinkingLevel,
                compaction: this.options.compaction,
                memoryEnabled: this.options.memoryEnabled,
                instructionsConfig: this.instructionsConfig,
                extensions,
                providerKeyStore: this.providerKeyStore,
                customProviders: this.customProviders,
                providerExtraModels: this.providerExtraModels,
                providerHiddenModels: this.providerHiddenModels,
                agents,
                resources: { skills },
                skillDiagnostics,
                imPolicy,
                // Re-resolve per turn rather than freezing the constructor-time
                // value: the store reads the file on each call (deliberately
                // uncached), so a policy edited by hand or from another process
                // reaches a live conversation on its next message.
                resolveImPolicy: (() => {
                    const route = scope.kind === "im" ? scope.route : undefined;
                    return route ? () => this.imPolicyStore.resolve(route) : undefined;
                })(),
                // The directories associated with this workspace — the ones it
                // may write to and `cd` into, beyond the workspace's own
                // root. Resolved per use (the store is uncached), so a grant
                // added or removed reaches a live conversation on its next
                // message without rebuilding the workspace.
                resolveAssociatedRoots: () => this.associationStore.resolve(scope.key).roots,
                toolRegistry,
                // Shared workspace approvals, including scheduler runs, reach every
                // initialized desktop. Headless runs deny asks immediately.
                hasApprover: () => this.clientSinkRegistry.hasClient(),
                // Hot-reload wiring: only the user-writable dirs are watched —
                // the builtin dir ships with the binary and only changes via
                // an app upgrade (a full restart), not hot-editing. Passing
                // both together is what makes WorkspaceRuntime opt into
                // watching; omitting either leaves reload off (e.g. tests that
                // construct WorkspaceRuntime directly without a live server).
                skillDirs: defaultSkillDirs(scope.executionCwd)
                    .filter((d) => d.source === "user")
                    .map((d) => d.path),
                reloadSkills: () => this.loadSkills(scope.executionCwd),
                // IM channel identity for the <im_channel> context tag — the
                // workspace only calls this for IM workspaces, passing the
                // route's channelId; peer/chat ids never reach it.
                resolveImChannel: (channelId) => this.channelControl.resolveImChannel(channelId),
                // In-process self-RPC entry — used by the memory tool (and future
                // self-RPC tools).
                dispatchRpc: (req) => this.handleRpcRequest(req),
                // Pushes tasks.updated to the desktop TaskPanel — shares
                // emitPush with CompactionPushAdapter; sessionKind routing is
                // handled by emitPush's lookup of AttachedSession.sessionKind.
                taskPushAdapter: new TaskPushAdapter((method, workspace, session, params) =>
                    this.emitPush(method, workspace, session, params),
                ),
                planPushAdapter: new PlanPushAdapter((method, workspace, session, params) =>
                    this.emitPush(method, workspace, session, params),
                ),
            });

            this.wireWorkspacePush(ws, scope.key);
        } catch (err) {
            // WorkspaceRuntime / push wiring failed. Dispose the provider
            // BEFORE rethrowing so its stdio children / HTTP sockets are
            // released. Single failure here is preferable to a leaked
            // process: every caller of ensureWorkspace sees the same error
            // and can retry.
            await (ws ? ws.dispose() : mcpProvider.dispose()).catch(() => undefined);
            throw err;
        }

        // One-time notice when a chat's local tools are first enabled. Keyed by
        // workspaceKey (policy is per-chat), not sessionId, so a session switch
        // does not repeat the notice. Skipped for non-IM workspaces.
        if (imPolicy) {
            const granted = imPolicy.tools.shell === "allow" || imPolicy.tools.fsTools === "allow";
            if (granted && !this.imPolicyStore.hasNotified(scope.key)) {
                this.emitPush(PushMethods.ImToolsEnabled, scope.key, undefined, {
                    text: imToolsEnabledNotice(this.requestUiLocale),
                });
                // The push already fired. A write failure must not surface as
                // an RPC error to the user (who already saw the notice) and
                // must not abort ensureWorkspace. The worst case is the
                // notice repeating after a sidecar restart, which is
                // acceptable.
                try {
                    await this.imPolicyStore.markNotified(scope.key);
                } catch (e) {
                    log.warn(`markNotified failed for ${scope.key}: ${e}`);
                }
            }
        }
        return ws;
    }

    /**
     * Workspace runtime internal events -> push frames to the client.
     *
     * workspaceKey (im:// URL for IM, fs path otherwise) is what emitPush's
     * IM_CWD_PREFIX branch matches against, so every frame carries the right
     * workspace identifier.
     */
    private wireWorkspacePush(ws: WorkspaceRuntime, workspaceKey: WorkspaceId): void {
        ws.on("session.event", (e: RuntimePushEvent) => {
            // Branch: tool_start / tool_update / tool_end split into named
            // push methods (session.tool_call_*); others stay as a blob in session.event.
            // Named events let the client route directly by method (no per-
            // message type switch), and reusing toolCallId as the push
            // frame.id lets the client dispatcher dedupe.
            const toolPush = toToolCallPush(e.event);
            if (toolPush) {
                this.emitPush(
                    toolPush.method,
                    workspaceKey,
                    e.sessionId,
                    toolPush.params,
                    toolPush.id,
                );
                return;
            }
            // ── compaction status push ──
            // The controller's paired lifecycle signal arrives here: `start`
            // records t0 + tokensBefore, `end` carries the committed summary (or
            // the classified failure) and removes the in-flight record. Desktop
            // unfreezes on the finished frame either way, and shows an error
            // toast only when it carries `failed: true`.
            if (this.compactionAdapter.handleSessionEvent(workspaceKey, e.sessionId, e.event)) {
                return; // adapter already emitted CompactionStarted/Finished, skip raw session.event
            }
            // User messages: strip hidden tags (e.g. ask_user_context) before
            // pushing to the UI — the model context is preserved, only the
            // display is hidden. Shallow-copy to avoid mutating the event.
            // If the stripped content is empty, the whole message is dropped
            // to avoid rendering an empty bubble.
            const evt = e.event as {
                type?: string;
                message?: { role?: string; content?: string | (TextContent | ImageContent)[] };
            };
            if (
                evt?.type === "message_end" &&
                evt.message?.role === "user" &&
                evt.message.content !== undefined
            ) {
                const view = viewUserContent(evt.message.content);
                if (view.empty) return;
                this.emitPush(PushMethods.Event, workspaceKey, e.sessionId, {
                    event: {
                        ...evt,
                        message: {
                            ...evt.message,
                            content: view.content,
                            ...(view.attachments.length > 0
                                ? { attachments: view.attachments }
                                : {}),
                        },
                    },
                });
                return;
            }
            this.emitPush(PushMethods.Event, workspaceKey, e.sessionId, {
                event: normalizeMessageUpdate(e.event),
            });
        });
        ws.permissionBroker.on("requested", (request) => {
            const [redacted] = redactCommandPermissionRequest(request);
            const routingSession = request.displaySessionId ?? request.sessionId;
            this.emitPush(PushMethods.CommandPermissionRequested, workspaceKey, routingSession, {
                ...redacted,
                text: `${imPermissionNotice("requested", this.requestUiLocale)}${routingSession}`,
            });
        });
        ws.permissionBroker.on(
            "resolved",
            ({
                request,
                decision,
            }: {
                request: CommandPermissionRequest;
                decision: CommandPermissionDecision;
            }) => {
                this.emitPush(
                    PushMethods.CommandPermissionResolved,
                    workspaceKey,
                    request.displaySessionId ?? request.sessionId,
                    {
                        requestId: request.requestId,
                        approved: decision.approved,
                        ...(decision.denialReason ? { denialReason: decision.denialReason } : {}),
                        text: imPermissionNotice(
                            decision.approved
                                ? "approved"
                                : decision.denialReason === "timeout"
                                  ? "timeout"
                                  : "denied",
                            this.requestUiLocale,
                        ),
                    },
                );
            },
        );
        ws.on("session.attached", (e: RuntimePushEvent) => {
            this.emitPush(PushMethods.Attached, workspaceKey, e.sessionId, {});
            // Proactively push current task/plan store snapshots — covers
            // attaching to an existing session and the case where desktop
            // restarted without any subsequent mutation tool call.
            ws.publishCurrentTaskSnapshot(e.sessionId);
            ws.publishCurrentPlanSnapshot(e.sessionId);
        });
        ws.on("session.detached", (e: RuntimePushEvent) => {
            this.emitPush(PushMethods.Detached, workspaceKey, e.sessionId, {});
        });
        ws.on("session.error", (e: RuntimePushEvent) => {
            this.emitPush(PushMethods.Error, workspaceKey, e.sessionId, {
                error: e.error instanceof Error ? e.error.message : String(e.error),
            });
        });
        ws.on("session.deleted", (e: { sessionId: SessionId }) => {
            // Append as a terminal sequenced event so a client that consumed
            // seq=N receives N+1 (clearing first would reset to seq=1 and the
            // cursor would discard it as a duplicate). Retain the tombstone
            // for reconnect recovery, then release the stream after a short TTL.
            this.emitPush(PushMethods.SessionDeleted, workspaceKey, e.sessionId, {});
            setTimeout(
                () => this.sessionEvents.clearSession(workspaceKey, e.sessionId),
                TOMBSTONE_TTL_MS,
            ).unref();
        });
        ws.on("session.renamed", (e: { sessionId: SessionId; name: string }) => {
            this.emitPush(PushMethods.SessionRenamed, workspaceKey, e.sessionId, {
                name: e.name,
            });
        });
        ws.on(
            "subagent.settled",
            (e: {
                parentSessionId: SessionId;
                parentToolCallId: string;
                subSessionId: SessionId;
                agentType: string;
                outcome: "completed" | "error" | "aborted";
            }) => {
                this.emitPush(PushMethods.SubagentSettled, workspaceKey, e.parentSessionId, {
                    parentSessionId: e.parentSessionId,
                    parentToolCallId: e.parentToolCallId,
                    subSessionId: e.subSessionId,
                    agentType: e.agentType,
                    outcome: e.outcome,
                });
            },
        );
        ws.on(
            "subagent.spawned",
            (e: {
                parentSessionId: SessionId;
                parentToolCallId: string;
                subSessionId: SessionId;
                agentType: string;
            }) => {
                this.emitPush(PushMethods.SubagentSpawned, workspaceKey, e.parentSessionId, {
                    parentSessionId: e.parentSessionId,
                    parentToolCallId: e.parentToolCallId,
                    subSessionId: e.subSessionId,
                    agentType: e.agentType,
                });
            },
        );
    }

    /** For handlers / method layer */
    async disposeWorkspace(cwd: WorkspaceId): Promise<void> {
        const disposed = await this.workspaces.remove(cwd);
        if (!disposed) return;
        this.sessionEvents.clearWorkspace(cwd);
        // Clean the channel → workspace reverse index so dispose does not leave
        // stale keys (memory leak across channel lifetime).
        if (cwd.startsWith(IM_CWD_PREFIX)) {
            const parsed = parseImCwd(cwd);
            if (parsed) this.channelRegistry.untrackWorkspace(parsed.channelId, cwd);
        }
    }

    /**
     * Drop every cached IM workspace for a channel after an admin policy write.
     * Without this, `ensureWorkspace` early-returns from the workspace cache
     * and the new policy would not take effect until a sidecar restart.
     *
     * TRADEOFF: this releases attached sessions and interrupts any in-flight
     * turn on those workspaces. Acceptable for a low-frequency admin action;
     * must not be wired into a hot path (e.g. every inbound message).
     */
    async invalidateImWorkspaces(channelId: string): Promise<void> {
        const keys = this.channelRegistry.workspacesForChannel(channelId);
        // Enqueue the notice BEFORE dispose: disposeWorkspace clears
        // sessionEvents and tears down listeners, so the frame must be
        // enqueued first to reach the client at all. This is enqueue-ordering
        // only — emitPush uses a fire-and-forget async write, so dispose is
        // intentionally not awaited on it. interruptedCount is hardcoded to 1:
        // each IM workspace currently hosts a single live conversation. If IM
        // ever supports parallel turns per workspace, count from sessionEvents
        // or the router instead.
        for (const key of keys) {
            this.emitPush(PushMethods.ImWorkspacesInvalidated, asWorkspaceId(key), undefined, {
                channelId,
                interruptedCount: 1,
            });
        }
        for (const key of keys) {
            await this.disposeWorkspace(asWorkspaceId(key));
        }
    }

    /**
     * Server-side policy write entry points. Persist via the store, then drop
     * every cached workspace for that channel so the next ensureWorkspace
     * constructs a WorkspaceRuntime with the new policy. Without this step
     * the new policy would only take effect on sidecar restart.
     *
     * After invalidating, broadcast an `im.policy_changed` push so any open
     * desktop editor re-pulls `imPolicy.get` on the same tick. The broadcast
     * is best-effort — a handler error must not abort the write.
     *
     */
    async setImChannelDefault(
        channelId: string,
        patch: Parameters<ImWorkspacePolicyStore["setChannelDefault"]>[1],
    ): Promise<void> {
        await this.imPolicyStore.setChannelDefault(channelId, patch);
        await this.invalidateImWorkspaces(channelId);
        this.broadcastImPolicyChanged(channelId);
    }

    async setImChatOverride(
        route: Parameters<ImWorkspacePolicyStore["setChatOverride"]>[0],
        patch: Parameters<ImWorkspacePolicyStore["setChatOverride"]>[1],
    ): Promise<void> {
        await this.imPolicyStore.setChatOverride(route, patch);
        await this.invalidateImWorkspaces(route.channelId);
        this.broadcastImPolicyChanged(route.channelId);
    }

    async clearImChatOverride(
        input: { route: ImRoute } | { chatKey: string },
        channelId: string,
    ): Promise<void> {
        if ("route" in input) {
            await this.imPolicyStore.clearChatOverride(input.route);
        } else {
            await this.imPolicyStore.clearChatOverrideByKey(channelId, input.chatKey);
        }
        await this.invalidateImWorkspaces(channelId);
        this.broadcastImPolicyChanged(channelId);
    }

    /**
     * Replace the custom provider set (pushed by the handler after
     * settings.write changes customProviders).
     *
     * Updates the server's held value and pushes to every existing
     * workspace's ModelRegistry, triggering reconciliation (add/remove
     * custom providers; builtins untouched). Newly created workspaces
     * will then read the latest value automatically.
     */
    setCustomProviders(next: readonly CustomProviderConfig[]): void {
        this.customProviders = next;
        for (const ws of this.workspaces.list()) {
            ws.setCustomProviders(next);
        }
    }

    /**
     * Replace the user's model-list edits for built-in providers (pushed by the
     * handler after settings.write changes providerExtraModels /
     * providerHiddenModels). Updates the server's held values for workspaces
     * built later and re-registers wrapped built-ins in every existing
     * workspace's ModelRegistry.
     */
    setProviderModelEdits(
        extras: Record<string, CustomModelEntry[]>,
        hidden: Record<string, string[]>,
    ): void {
        this.providerExtraModels = extras;
        this.providerHiddenModels = hidden;
        for (const ws of this.workspaces.list()) {
            ws.setProviderModelEdits(extras, hidden);
        }
    }

    /** Resolve a registered provider's endpoint for model discovery (provider.listModels "saved" branch). */
    getProviderEndpoint(
        providerId: string,
    ): { baseUrl: string; api: CustomProviderApi } | undefined {
        return resolveProviderEndpoint(providerId, this.customProviders);
    }

    /** Build the pi Provider for a registered id (provider.testConnection "saved" branch). */
    buildProvider(providerId: string): Provider | undefined {
        return resolveProvider(
            providerId,
            this.customProviders,
            this.providerExtraModels,
            this.providerHiddenModels,
        );
    }

    /**
     * Update the default model/provider at runtime (pushed by the settings.write
     * handler after the user picks a provider+model in Settings/onboarding).
     *
     * Updates the server's held options so workspaces built LATER read the new
     * value, and pushes into every EXISTING workspace so the next session.create
     * resolves the configured default instead of the construction-time fallback
     * (first catalog model, typically anthropic/*). This is the fix for a fresh
     * session failing with "Provider is not configured: anthropic" after the
     * user configured a different provider post-startup.
     */
    setDefaultModel(defaultModel?: string, defaultProvider?: string): void {
        this.options.defaultModel = defaultModel;
        this.options.defaultProvider = defaultProvider;
        for (const ws of this.workspaces.list()) {
            ws.setDefaultModel(defaultModel, defaultProvider);
        }
    }

    /**
     * Invalidate compaction caches in every workspace. Called by the
     * settings.write handler after writing the compaction field, so all
     * attached sessions' next `effectiveCompaction()` reads the new disk
     * value immediately instead of waiting for the TTL.
     */
    invalidateCompactionCaches(): void {
        for (const ws of this.workspaces.list()) {
            ws.invalidateCompactionCache();
        }
    }

    /**
     * Rescan agent definitions for every workspace after an `agents.write` /
     * `agents.delete`. Unlike `reloadMcpServers` this does not dispose
     * workspaces: the catalog is re-derived per workspace and installed
     * narrowly (spawner + prompt section), so attached sessions keep running.
     */
    async reloadAgents(): Promise<void> {
        const builtinDir = join(resourceRoot(), "agents", "builtin");
        for (const ws of this.workspaces.list()) {
            ws.reloadAgentsNow(
                await loadAgents({ builtinDir, userDirs: defaultAgentDirs(ws.executionCwd) }),
            );
        }
    }

    /** Update MCP defaults for future builds; live sessions retain their toolset until release. */
    async reloadMcpServers(): Promise<void> {
        this.mcpServers = readGlobalConfig().mcpServers ?? [];
    }

    /**
     * Hot-reload the `InstructionsConfig` for every workspace. Each
     * workspace's sessionRegistry re-reads via a lazy thunk on the next LLM
     * call — no per-session invalidation needed. Called from the
     * `settings.write` handler after writing the `instructions` field.
     *
     * The instance field write mirrors `setCustomProviders` / `setDefaultModel`:
     * without it, a server with zero built workspaces (e.g. a headless runtime
     * before any job has fired) would silently drop the patch — the next
     * `ensureWorkspace` would read the stale boot-time value from
     * `buildWorkspace`.
     */
    refreshInstructions(next: InstructionsConfig | undefined): void {
        this.instructionsConfig = next;
        for (const ws of this.workspaces.list()) {
            ws.updateInstructionsConfig(next);
        }
    }

    /** IM channel control surface consumed by the `channels.*` handlers.
     *  A data property rather than a getter: tests stub the whole surface to
     *  drive bind error paths, and `readonly` is compile-time only. */
    readonly channels: ChannelControl;

    /**
     * The global rules an IM workspace on `channelId` evaluates against: the
     * user's `commandPermissions` plus extension allow-rules, merged the same
     * way the workspace permission thunk does. A malformed taco.json yields no
     * global rules instead of failing the whole policy editor.
     */
    private async imPolicyGlobalRules(
        channelId: string,
    ): Promise<{ allow: string[]; deny: string[] }> {
        let allow: string[] = [];
        let deny: string[] = [];
        try {
            const base = validateCommandPermissions(
                readGlobalConfig().commandPermissions,
                "taco.json",
            );
            allow = base.allow ?? base.rules ?? [];
            deny = base.deny ?? [];
        } catch (e) {
            log.warn(`imPolicy.get: ignoring invalid commandPermissions: ${String(e)}`);
        }
        const extensions = await activateExtensions(this.extensionRegistry, {
            cwd: join(makeImSessionsRoot(tacoHome(), channelId), "scratch"),
            isIm: true,
        });
        return {
            allow: Array.from(new Set([...allow, ...extensions.commandPermissionRules()])),
            deny,
        };
    }

    /** IM workspace policy control surface consumed by the `imPolicy.*` handlers. */
    readonly imPolicy: ImPolicyControl = {
        get: async (params) => {
            const channelId = params.channelId;
            // The stored document may still hold legacy `binding` /
            // `perChatScratch` fields; normalize on read so the editor only
            // ever sees the canonical `executionDir` shape.
            const doc = normalizePolicyDocument(this.imPolicyStore.readDocument(channelId));
            const conversations = this.conversationRouter?.listAll(channelId) ?? [];
            const overrides = describeImChatOverrides(doc, channelId, conversations);
            const peerId = params.peerId;
            const chatId = params.chatId;
            const wantsChat = !!(peerId && chatId);
            const chatOverride = wantsChat
                ? (doc.chats?.[
                      chatPolicyKey({
                          channelId,
                          peerId: peerId as string,
                          chatId: chatId as string,
                      })
                  ] ?? null)
                : null;
            const resolved = wantsChat
                ? this.imPolicyStore.resolve({
                      channelId,
                      peerId: peerId as string,
                      chatId: chatId as string,
                  })
                : resolveChannelDefaultFromDocument(doc);
            const route: ImRoute | null = wantsChat
                ? {
                      channelId,
                      peerId: peerId as string,
                      chatId: chatId as string,
                  }
                : null;
            const commandPermissions = await this.imPolicyGlobalRules(channelId);
            return {
                channelId,
                scope: wantsChat ? "chat" : "channel",
                channelDefault: doc.default ?? {},
                resolved,
                chatOverride,
                hasOverride: chatOverride !== null,
                overrides,
                sources: describeImPolicySources(doc, route),
                rules: describeImPolicyRules(doc, route, commandPermissions),
            };
        },
        setChannelDefault: (channelId, patch) => this.setImChannelDefault(channelId, patch),
        setChatOverride: (route, patch) => this.setImChatOverride(route, patch),
        clearChatOverride: (input, channelId) => this.clearImChatOverride(input, channelId),
    };

    /**
     * Workspace directory-association control surface, consumed by the
     * `workspace.associations.*` handlers.
     *
     * The store is file-backed and read on every use, so a write takes
     * effect for every workspace in the process at once — no invalidation
     * pass, and no stale copy to reconcile. What still needs the server is
     * the push fan-out: the affected workspaces must be addressed by the
     * server that owns them, and in daemon mode the IM workspaces live on
     * the resident host rather than on the connection server that received
     * the request.
     */
    readonly associations: WorkspaceAssociationsControl = {
        get: (key) => this.associationStore.get(key),
        set: async (key, roots) => {
            const stored = await this.associationStore.set(key, roots);
            this.broadcastAssociationsChanged(key);
            return stored;
        },
        resolve: (workspace) => this.associationStore.resolve(workspace),
        broadcastChanged: (key) => this.broadcastAssociationsChanged(key),
    };

    /** Fans a channel binding transition out to every workspace. Binding is
     *  process-level, but push frames are workspace-routed, so each open
     *  workspace gets a copy — the client dedupes by channelId. IM workspaces
     *  are skipped for the same reason as broadcastConversationsChanged: they
     *  scale with conversation count and never render the Channels pane. */
    broadcastChannelStatus(channel: ChannelStatusEntry): void {
        for (const cwd of this.workspaces.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ChannelStatusChanged, cwd, undefined, { channel });
        }
    }

    /** Invalidate notification for `channels.listConversations`. Triggered by
     *  ConversationRouter when a NEW session is created (not on every inbound
     *  message). Empty payload — desktop re-pulls the conversation list.
     *
     *  IM workspaces are skipped: the workspace registry is keyed by workspaceKey, so
     *  every routed conversation occupies a slot. Fanning out to those too
     *  would make the push count grow with conversation count, and each copy
     *  costs the client a full listConversations re-pull. Only real (fs)
     *  workspaces host the Channels pane that consumes this. */
    broadcastConversationsChanged(): void {
        for (const cwd of this.workspaces.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ConversationsChanged, cwd, undefined, {});
        }
    }

    broadcastModelsChanged(): void {
        // Workspace-dimensioned push (no session) — desktop re-pulls
        // providers.list / session.listModels for this workspace. IM workspaces
        // don't render a model picker, so skip them like the other broadcasts.
        for (const cwd of this.workspaces.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ModelsChanged, cwd, undefined, {});
        }
    }

    /**
     * Workspace-dimensioned invalidate: a policy write landed for `channelId`.
     * Non-IM workspaces host the Channels pane (where the editor lives), so
     * they get the push; IM workspaces are skipped because they don't render
     * the Channels pane and the policy takes effect on the next ensureWorkspace.
     *
     * Intentionally not scoped by channel on the receiving end: each
     * non-IM workspace sees the push, and the client filters by channelId
     * in `useImPolicy.onImPolicyChanged`. A typical desktop has 1–2 fs
     * workspaces, so the wasted frame is negligible vs. plumbing a
     * channel→workspaces registry for a one-line saving.
     */
    broadcastImPolicyChanged(channelId: string): void {
        for (const cwd of this.workspaces.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ImPolicyChanged, cwd, undefined, { channelId });
        }
    }

    /**
     * Announce that an association set changed.
     *
     * The push is workspace-dimensioned, so it fans out over the live
     * workspaces whose effective set could have moved:
     *  - a workspace-scope change touches exactly that workspace;
     *  - a channel-scope change touches every IM conversation on the
     *    channel, plus the fs workspaces that could inherit it — none
     *    today, since only IM workspaces fall back to a channel.
     *
     * The frame's `workspace` field names the affected workspace, so a
     * client can refresh the panel it is showing without re-pulling every
     * workspace. The `key` in the params says which set moved, for a
     * client that shows a channel-level and a conversation-level editor
     * side by side.
     *
     * The pushed key keeps the caller's spelling — the wire contract is
     * raw strings, and the client matches what it sent. Which workspaces
     * the push reaches is decided by `associationAffectsWorkspace`, which
     * normalizes both sides.
     */
    broadcastAssociationsChanged(key: WorkspaceAssociationKey): void {
        for (const cwd of this.workspaces.keys()) {
            if (!associationAffectsWorkspace(cwd, key)) continue;
            this.emitPush(PushMethods.WorkspaceAssociationsChanged, cwd, undefined, { key });
        }
    }

    private emitPush<M extends PushMethodName>(
        method: M,
        workspace: WorkspaceId,
        session: SessionId | undefined,
        params: PushParams<M>,
        id?: string,
    ): void {
        // Structural routing metadata: the client uses sessionKind to decide
        // whether a frame belongs to the main session or a subagent session,
        // without depending on the "known child session set" arrival timing
        // (see ServerPush.sessionKind). Look up the AttachedSession's
        // sessionKind synchronously via the attached map; frames without
        // a session dimension leave it empty.
        const sessionKind =
            session !== undefined
                ? this.workspaces.get(workspace)?.getSessionKind(session)
                : undefined;
        const frame =
            session === undefined
                ? makePushFrame({ method, workspace, session, sessionKind, params, id })
                : this.sessionEvents.append(workspace, session, (seq) =>
                      makePushFrame({ method, workspace, session, sessionKind, seq, params, id }),
                  );
        void this.getTransport().send(frame);
        this.clientSinkRegistry.fanout(frame, this.transport);
        // im:// workspaces additionally fan-out channel pushes (additive sink; no return; stdio always sends)
        if (workspace.startsWith(IM_CWD_PREFIX)) {
            const parsed = parseImCwd(workspace);
            if (parsed) this.channelRegistry.push(parsed.channelId, frame);
        }
    }
}
