/**
 * SidecarServer — NDJSON over stdio
 *
 * Read: one line per frame, parsed as RpcRequest, routed by method to handler.
 * Write: push frames from the workspace runtime are written directly to stdout.
 *
 * Push frame deduplication is NOT done here — the runtime guarantees it
 * does not emit duplicates; the server only does "serialize + write".
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadSourcedSkills, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
    type ChannelStatusEntry,
    type ChannelsBindResult,
    type ChannelsCreateResult,
    type ChannelsListResult,
    type ClientCapabilities,
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
    type SessionEventsGetResult,
    type SessionId,
    type SidecarCapabilities,
    type SkillDiagnosticEntry,
    type SupportedLocale,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { loadAgents } from "../agents/loadAgents.ts";
import type { AgentDefinition } from "../agents/types.ts";
import { BUILTIN_CHANNEL_MANIFESTS } from "../channels/builtinManifests.ts";
import type { ChannelBindStatus } from "../channels/channelBindBroker.ts";
import { ChannelBindBroker } from "../channels/channelBindBroker.ts";
import { FileChannelConfigStore, hasStoredCredentials } from "../channels/channelConfigStore.ts";
import { ChannelFactory } from "../channels/channelFactory.ts";
import { isValidChannelId } from "../channels/configValidator.ts";
import { ConversationRouter } from "../channels/conversationRouter.ts";
import type { ImRoute, ImWorkspacePolicy } from "../channels/imWorkspacePolicy.ts";
import {
    chatPolicyKey,
    describeImChatOverrides,
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
    type ResolvedCompaction,
    readGlobalConfig,
    saveGlobalConfig,
} from "../config/config.ts";
import { tacoHome } from "../config/tacoHome.ts";
import { activateExtensions } from "../extensions/activation.ts";
import type { ExtensionRegistry, WorkspaceExtensionSet } from "../extensions/index.ts";
import { SingleFlight } from "../lib/async.ts";
import { createLogger } from "../lib/logger.ts";
import { discoverMcpTools } from "../mcp/mcpToolProvider.ts";
import { PlanPushAdapter } from "../plan/planPushAdapter.ts";
import { DefaultDeferredToolRegistry } from "../runtime/deferredToolRegistry.ts";
import type { ProviderKeyStore } from "../runtime/providerKeyStore.ts";
import { resourceRoot } from "../runtime/runtimeResources.ts";
import type {
    ChannelControl,
    ImPolicyControl,
    JobsControl,
    ServerRpcSurface,
} from "../runtime/serverRpcSurface.ts";
import { SlashNormalizedExecutionEnv } from "../runtime/slashNormalizedEnv.ts";
import { WorkspaceRuntime } from "../runtime/workspace.ts";
import { dedupeSkillsByNameWithDuplicates } from "../skills/dedupeSkills.ts";
import {
    checkSkillFrontmatter,
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
} from "../skills/skillDiagnostics.ts";
import {
    clearSkillFrontmatterCache,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../skills/skillFrontmatter.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import {
    applyTuiVisibilityToContent,
    type ImChannelContext,
    isContentEmptyAfterVisibility,
} from "../tags/index.ts";
import { TaskPushAdapter } from "../tasks/taskPushAdapter.ts";
import type { ClientSinkRegistry } from "./clientSinkRegistry.ts";
import { CompactionPushAdapter } from "./compactionPushAdapter.ts";
import { resolveImExecutionCwd } from "./imExecutionCwd.ts";
import { getRegisteredMethod, listRegisteredMethods, type MethodCtx } from "./methodRegistry.ts";
import { registerBuiltinMethods } from "./methods.ts";
import { makePushFrame, redactCommandPermissionRequest, toToolCallPush } from "./push.ts";
import {
    type CommandOutcome,
    err,
    getTurnKey,
    normalizeError,
    ok,
    toCommandOutcome,
    withRequestId,
} from "./rpcResponse.ts";
import type { ServerRegistry } from "./serverRegistry.ts";
import { SessionEventLog } from "./sessionEventLog.ts";
import { StdioTransport } from "./stdioTransport.ts";
import type { Transport } from "./transport.ts";
import { parseJsonPointer } from "./validation.ts";

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
     * `refreshInstructions` (which iterates `serverRegistry` if present).
     *
     * Without this being passed at construction, every workspace falls
     * back to `mergeWithDefaults()` and the user's `taco.json
     * instructions` block is silently ignored (pre-fix bug; the
     * WorkspaceRuntime `instructionsConfig` field stayed `undefined`
     * for the entire process lifetime).
     */
    instructionsConfig?: InstructionsConfig;
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
    /** Custom provider config (parsed at startup from taco.json), injected into every workspace's catalog */
    customProviders?: readonly CustomProviderConfig[];
    /** MCP servers whose tools become dynamic-tool candidates (parsed at startup from taco.json). */
    mcpServers?: readonly McpServerConfig[];
    /** Maximum number of settled command outcomes retained for retry idempotency. */
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
    /** Transport instance; defaults to StdioTransport. */
    transport?: Transport;
    /** Channel configs for IM channels; Channel instances are resolved from manifest.name via ChannelFactory. */
    channels?: readonly ChannelConfig[];
    /**
     * Scheduler-facing API exposed to the `jobs.*` handlers. The daemon
     * entry point (src/index.ts) constructs one JobsController from the
     * JobStore + Scheduler it boots, and shares it across every NDJSON
     * connection's SidecarServer.
     */
    jobs?: JobsControl;
    /**
     * Process-level IM channel stack (daemon mode). When set, this server
     * is a non-owner connection server: it does NOT re-start channels,
     * does NOT own IM workspaces, and forwards `im://` session RPCs to
     * `imHost` via `dispatchRpc`. Omit on stdio single-process sidecars
     * and in tests — those keep the existing self-construct behaviour.
     */
    channelRegistry?: ChannelRegistry;
    channelBindBroker?: ChannelBindBroker;
    conversationRouter?: ConversationRouter;
    /**
     * The daemon-resident IM host. Set together with the three channel-stack
     * fields above; connection servers receive all four as a unit so a
     * missing `imHost` is treated as "this is the owner" rather than a
     * half-configured non-owner. The resident itself is constructed without
     * `imHost` (and therefore owns).
     */
    imHost?: ServerRpcSurface;
    /**
     * Process-level fan-out registry for desktop transports (Phase 2). The
     * resident uses it to deliver IM push frames to every connected
     * desktop's NDJSON transport so an already-open IM session view stays
     * live (new peer messages, mid-turn updates). Constructed once by
     * `runDaemon` and shared via SharedSidecarDeps. Omit on stdio /
     * tests — those have a single SidecarServer whose own transport is
     * the only sink, so fanout is unnecessary.
     */
    clientSinkRegistry?: ClientSinkRegistry;
    /**
     * Process-level fan-out registry for settings setters. The
     * `settings.write` handler iterates `serverRegistry.all() ?? [server]`
     * so a desktop-initiated patch reaches every SidecarServer in the
     * process — including `schedulerSidecar`, which never sees the
     * desktop's RPC. Constructed once by `runDaemon` and shared via
     * SharedSidecarDeps. Omit on stdio / tests — the handler falls back
     * to `[server]` and behaviour matches the pre-fix single-server path.
     */
    serverRegistry?: ServerRegistry;
}

interface CommandRecord {
    fingerprint: string;
    outcome: Promise<CommandOutcome>;
    settled: boolean;
    /** Monotonic deadline: created_at + commandRecordTtlMs. */
    expiresAt: number;
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

/** How long a deleted session's tombstone stays in the replay log. */
const TOMBSTONE_TTL_MS = 60_000;

/** Default idempotency window for command outcomes. See commandRecordTtlMs. */
const DEFAULT_COMMAND_RECORD_TTL_MS = 10 * 60_000;

export class SidecarServer implements ServerRpcSurface {
    private readonly workspaceMap = new Map<WorkspaceId, WorkspaceRuntime>();
    private readonly commandRecords = new Map<string, CommandRecord>();
    private readonly activeTurnCommands = new Map<string, Promise<CommandOutcome>>();
    private readonly sessionEvents = new SessionEventLog();
    /**
     * Cold-start single-flight for workspace constructions, keyed by
     * workspaceKey. Concurrent ensureWorkspace() calls for the same cwd
     * share one promise; without this N parallel RPCs each run the full
     * asset-load + MCP-discovery + push-wire path, leaking the loser's
     * MCP handles and double-writing the imPolicyStore.
     */
    private readonly workspaceFlight = new SingleFlight<WorkspaceId, WorkspaceRuntime>((cwd) =>
        this.buildWorkspace(cwd),
    );
    private readonly options: SidecarServerOptions;
    private readonly commandRecordTtlMs: number;
    private readonly now: () => number;
    private commandSweeper?: ReturnType<typeof setInterval>;
    /** IM workspace policy store — admin-granted, survives channel unbind. */
    readonly imPolicyStore: ImWorkspacePolicyStore;
    /**
     * Whether the connected client has completed the `initialize` handshake.
     * Every RPC except `initialize` is rejected with `not_initialized` while
     * this is false. Reset to false in `stop()` so a re-`start()` requires
     * a fresh handshake.
     */
    private isInitialized = false;
    /**
     * UI locale the connected client declared at `initialize` time.
     * Server-side notices (e.g. the IM "local tools granted" banner) key off
     * this so users see their own language instead of a hardcoded fallback.
     * Undefined until `initialize` completes; defaults to "en" for any locale
     * we don't ship a translation for.
     */
    private clientUiLocale: SupportedLocale | undefined;
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
    /**
     * Shared channel stack. On a non-owner (daemon connection server),
     * these point at the daemon-resident instances injected via options.
     * On an owner (stdio sidecar, the resident itself, tests), they are
     * freshly constructed in the ctor — current self-construct behaviour.
     */
    readonly channelRegistry: ChannelRegistry;
    readonly channelBindBroker: ChannelBindBroker;
    /** Resolved by the ctor after the broker + router exist. */
    private readonly channelFactory: ChannelFactory;
    private conversationRouter?: ConversationRouter;
    /**
     * Read-only view of the conversation router. Exposed for tests that
     * need to assert state sharing across owners / non-owners; production
     * callers go through the channel stack (`channels.listConversations`).
     */
    get conversationRouterView(): ConversationRouter | undefined {
        return this.conversationRouter;
    }
    /** Single ownership bit for the channel stack. `imHost` unset means
     *  this server is the owner; set means it forwards im:// work to the
     *  resident host. */
    private readonly ownsChannels: boolean;
    /** Daemon-resident host for im:// dispatch. Undefined on the resident
     *  itself and on stdio / test owners. */
    private readonly imHost?: ServerRpcSurface;
    /** Process-level fan-out registry. The owner uses it to deliver im://
     *  push frames to every connected desktop's NDJSON transport. */
    private readonly clientSinkRegistry?: ClientSinkRegistry;
    /** Settings-setter fan-out — see SidecarServerOptions.serverRegistry. */
    private readonly serverRegistry?: ServerRegistry;
    /** taco.json channel instances, kept so channels.list can report the
     *  configured set independently of which ones actually started. */
    private channelConfigs: readonly ChannelConfig[] = [];
    private failedChannels: readonly { channelId: string; error: string }[] = [];
    private transport?: Transport;
    /**
     * True once stop() has run. Used by buildWorkspace to drop a workspace it
     * was constructing when shutdown raced in — without this the worker would
     * silently publish a ws that no caller will ever see (workspaceMap was
     * cleared). Distinct from `isInitialized`, which tracks the initialize
     * RPC handshake and is false for IM-only sidecars that never call it.
     */
    private stopped = false;

    /** Lazily creates a StdioTransport if transport is not set (for tests that call server methods without start()). */
    private getTransport(): Transport {
        return this.transport ?? new StdioTransport();
    }
    /**
     * Compaction state machine + push frame assembly — translates
     * session_before_compact / session_compact into CompactionStarted /
     * CompactionFinished named pushes. isCompressing / awaitCompactionEnd
     * are forwarded to RPC handlers (session.prompt / steer). See adapter.
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

    lookupRoute(workspace: string): { sessionId: string } | undefined {
        return this.conversationRouter?.lookupByWorkspace(workspace);
    }

    /**
     * `ServerRpcSurface.markInitialized` — flip the `not_initialized` guard after the
     * `initialize` handler accepts the client's protocol version. Idempotent.
     * Only `uiLocale` is retained — IM notices key off it. Other capability
     * fields are accepted for forward compatibility but not stored.
     */
    markInitialized(capabilities: ClientCapabilities): void {
        this.isInitialized = true;
        this.clientUiLocale = capabilities.uiLocale;
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
        this.options = options;
        // Guard against 0 / negative TTL: expiresAt would be permanently
        // expired (records unusable) and setInterval(<=0) would busy-spin.
        this.commandRecordTtlMs = Math.max(
            1,
            options.commandRecordTtlMs ?? DEFAULT_COMMAND_RECORD_TTL_MS,
        );
        this.now = options.now ?? (() => performance.now());
        this.extensionRegistry = options.extensionRegistry;
        this.providerKeyStore = options.providerKeyStore;
        this._jobs = options.jobs;
        this.customProviders = options.customProviders ?? [];
        // instructionsConfig is captured at construction so every
        // workspace built by buildWorkspace() sees the same value. The
        // existing refreshInstructions() hot-reload path stays
        // unchanged — it pushes updates to already-built workspaces via
        // the serverRegistry fan-out.
        this.instructionsConfig = options.instructionsConfig;
        this.mcpServers = options.mcpServers ?? [];
        this.imPolicyStore = new ImWorkspacePolicyStore();
        // Daemon-resident ownership: when `imHost` is injected, this server
        // is a non-owner connection instance — skip loadAndStart, forward
        // im:// RPCs, delegate imPolicy writes. Otherwise (stdio / tests /
        // the resident itself) self-construct and own, preserving the
        // current behaviour byte-for-byte.
        this.ownsChannels = options.imHost === undefined;
        this.imHost = options.imHost;
        this.clientSinkRegistry = options.clientSinkRegistry;
        this.serverRegistry = options.serverRegistry;
        this.channelRegistry = options.channelRegistry ?? new ChannelRegistry();
        this.channelBindBroker = options.channelBindBroker ?? new ChannelBindBroker();
        // `conversationRouter` is normally loaded in start() from disk, but
        // may be injected for owners too (the daemon-resident starts first
        // and shares the same router). Accept either.
        this.conversationRouter = options.conversationRouter;
        this.channelFactory = new ChannelFactory({
            broker: this.channelBindBroker,
            // Resolved at push time: the router only knows a route once the
            // peer's first message has created the session. On both owner
            // and non-owner, `this.conversationRouter` is the (injected or
            // loaded) shared router, so route lookups stay consistent.
            resolvePeer: (sessionId) =>
                this.conversationRouter?.findRouteBySessionId(sessionId)?.peerId,
            // Broadcast a workspace-dimensioned notice (e.g. the policy
            // interrupt notice) to every peer routed through a channel.
            listPeers: (channelId) =>
                this.conversationRouter?.listAll(channelId).map((e) => e.peerId) ?? [],
        });
        // Explicitly register all builtin method handlers instead of relying on module-level side-effect imports.
        registerBuiltinMethods();
    }

    /** For method handlers / tests — list cwd of currently active workspaces */
    workspaceIds(): WorkspaceId[] {
        return [...this.workspaceMap.keys()];
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

    /** Start the service — read stdin (NDJSON), write push events to stdout */
    async start(
        transport: Transport = this.options.transport ?? new StdioTransport(),
        channelConfigs: readonly ChannelConfig[] = this.options.channels ?? [],
    ): Promise<void> {
        this.transport = transport;
        transport.onRequest((line) => void this.handleLine(line));
        await transport.open();
        // Phase 2: register this transport so the host can push im:// frames
        // to every connected desktop. The host itself registers its
        // NullTransport here (no-op fanout), so the registry can be a single
        // uniform Set<Transport> rather than special-casing the host.
        this.clientSinkRegistry?.add(transport);
        this.serverRegistry?.add(this);

        // Router is normally loaded per-instance from disk. Daemon mode
        // injects a shared router so all instances see the same routes and
        // only one writer hits routing.json — accept the injection as-is.
        this.conversationRouter ??= await ConversationRouter.load(tacoHome());
        // Subscribe-and-rebroadcast: every server (owner + non-owner) subscribes
        // to the shared emitter so each connection's desktop receives
        // status_changed (bind QR codes), conversations_changed, and the
        // broadcasts can fan out to that server's own fs workspaces. Handlers
        // are stored as named refs so stop() can off() them.
        this.conversationRouter.on("conversation", this.onRouterConversation);
        this.channelConfigs = channelConfigs;
        this.channelBindBroker.on("status", this.onBrokerStatus);
        const startedChannelIds: string[] = [];
        if (this.ownsChannels && channelConfigs.length > 0) {
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
        } else if (!this.ownsChannels) {
            // Non-owner: channels are already running on the resident host;
            // advertise the daemon-level set so initialize capabilities stay
            // accurate in multi-connection setups.
            startedChannelIds.push(...this.channelRegistry.startedIds());
        }
        this.startedChannelIds = startedChannelIds;

        // Periodic TTL sweep: guarantees the command map cannot grow unbounded
        // even when no new RPC ever arrives (the original leak). unref so a
        // long-running sidecar can still exit; matches the TOMBSTONE pattern.
        // Trade-off: sweeping at exactly the TTL means a record can linger up
        // to ~2×TTL worst case (expired just after a sweep ran). Cheap memory
        // reclamation vs. tighter precision — for a 10min TTL the extra 10min
        // is acceptable and avoids a noisier interval.
        this.clearCommandSweeper();
        this.commandSweeper = setInterval(
            () => this.pruneCommandRecords(),
            this.commandRecordTtlMs,
        );
        this.commandSweeper.unref();
    }

    /** Named refs for stop() to off() — see start() for why this matters. */
    private readonly onRouterConversation = () => this.broadcastConversationsChanged();
    private readonly onBrokerStatus = (s: ChannelBindStatus) => {
        // Broker frames are the raw transition; the wire entry adds the
        // config-derived name and the on-disk configured flag. Building it
        // here keeps the push payload identical to `channels.list` output —
        // the client replaces the entry wholesale on applyChannelStatus.
        this.broadcastChannelStatus(this.toStatusEntry(s));
    };

    private clearCommandSweeper(): void {
        if (this.commandSweeper) {
            clearInterval(this.commandSweeper);
            this.commandSweeper = undefined;
        }
    }

    /** Stop — close all harnesses held by runtimes */
    async stop(): Promise<void> {
        // Set BEFORE we clear inflight, so any buildWorkspace that resolves
        // after the clear can observe "I lost the race" and reject rather
        // than publishing a zombie ws into a freshly-cleared map.
        this.stopped = true;
        // Phase 2: drop our transport from the fan-out set BEFORE closing it,
        // so any frames already enqueued by an in-flight emitPush don't
        // race the close and crash the sink. Matched in start().
        // Drop ourselves from both registries BEFORE closing the transport,
        // so any settings.write that lands mid-shutdown cannot target a
        // half-disposed server. Mirrors clientSinkRegistry ordering below.
        if (this.transport) {
            this.clientSinkRegistry?.remove(this.transport);
        }
        this.serverRegistry?.remove(this);
        await this.transport?.close();
        // Channels own long-lived loops (long-poll / sockets). Only the owner
        // tears them down; a non-owner stopping (e.g. one desktop disconnecting)
        // leaves the daemon-resident channels alive for every other connection.
        if (this.ownsChannels) {
            this.channelBindBroker.cancelAll();
            await this.channelRegistry.stopAll();
        }
        // Every instance unsubscribes from the shared emitters — otherwise
        // a dead connection's rebroadcast would keep firing on every status
        // change, and EventEmitter would eventually warn at >10 listeners.
        this.channelBindBroker.off("status", this.onBrokerStatus);
        if (this.conversationRouter) {
            this.conversationRouter.off("conversation", this.onRouterConversation);
        }
        for (const ws of this.workspaceMap.values()) {
            await ws.dispose();
        }
        this.workspaceMap.clear();
        // Drop any in-flight construction promises; their awaiters will
        // observe whatever the constructor throws, not a cancelled value.
        this.workspaceFlight.clear();
        this.commandRecords.clear();
        this.clearCommandSweeper();
        this.sessionEvents.clear();
        this.isInitialized = false;
        this.clientUiLocale = undefined;
        this.startedChannelIds = [];
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

    private async handleLine(line: string): Promise<void> {
        let req: RpcRequest;
        try {
            req = JSON.parse(line);
        } catch {
            return; // ignore bad frames
        }
        if (!req || typeof req.id !== "string" || typeof req.method !== "string") {
            return;
        }
        // The handshake guard lives here, on the external transport boundary —
        // NOT in handleRpcRequest. In-process callers (IM channel ingress,
        // ConversationRouter, the memory self-RPC tool) share handleRpcRequest
        // and have no client to perform `initialize`; gating them would break
        // headless sidecars. Only a stdio peer must handshake first.
        if (!this.isInitialized && req.method !== "initialize") {
            void this.getTransport().send(
                err(
                    req.id,
                    ErrorCodes.NotInitialized,
                    "sidecar must be initialized before calling other methods; call initialize first",
                ),
            );
            return;
        }
        const resp = await this.handleRpcRequest(req);
        void this.getTransport().send(resp);
    }

    /**
     * Handles an RpcRequest via the same path as NDJSON dispatch — handler
     * registry + middleware + RpcHandlerError -> RpcResponse.error translation
     * are all preserved. Used by in-process tools that self-RPC (see
     * `RpcDispatch.call` on the sidecar side) to avoid splitting RPC across
     * processes. No `not_initialized` gate here: in-process callers have no
     * handshake to perform. The gate lives in `handleLine`, the only path a
     * remote stdio client can reach.
     */
    async handleRpcRequest(req: RpcRequest): Promise<RpcResponse> {
        const reg = getRegisteredMethod(req.method);
        if (!reg) {
            return err(req.id, ErrorCodes.UnknownMethod, `unknown method: ${req.method}`);
        }

        // Daemon non-owner forwarding: connection servers do not host IM
        // workspaces — they live on the resident imHost, along with the live
        // AttachedSession and SessionEventLog. Forward im://-scoped session
        // RPCs to the host so schema validation, command idempotency, and
        // execution all happen against the single owner. Responses carry the
        // original id verbatim. Non-im:// RPCs execute locally as before.
        if (!this.ownsChannels) {
            const cwd =
                (req.params as { workspace?: string; cwd?: string } | undefined)?.workspace ??
                (req.params as { cwd?: string } | undefined)?.cwd;
            if (typeof cwd === "string" && cwd.startsWith(IM_CWD_PREFIX)) {
                const forwarded = await this.imHost?.dispatchRpc?.(req);
                if (forwarded) return forwarded;
                return err(req.id, ErrorCodes.InvalidState, "IM host unavailable");
            }
        }

        // Schema validation — only when the registration declared a typebox
        // schema. Failures short-circuit with `invalid_params` carrying the
        // JSON-pointer path so the desktop can render a precise error.
        if (reg.options.schema) {
            const errors = Value.Errors(reg.options.schema, req.params);
            if (errors.length > 0) {
                return err(req.id, ErrorCodes.InvalidParams, "parameter validation failed", {
                    issues: errors.map((e) => ({
                        path: parseJsonPointer(e.instancePath),
                        message: e.message ?? "validation error",
                        schema: e.schemaPath,
                    })),
                });
            }
        }

        if (!reg.options.command || req.commandId === undefined) {
            return await this.executeRpcRequest(req, reg);
        }
        if (typeof req.commandId !== "string" || req.commandId.length === 0) {
            return err(req.id, ErrorCodes.InvalidParams, "commandId must be a non-empty string");
        }

        const key = `${req.method}\u0000${req.commandId}`;
        const fingerprint = JSON.stringify(req.params ?? null);
        const existing = this.commandRecords.get(key);
        if (existing) {
            // Lazy TTL expiry: a stale record is treated as absent so a retry
            // re-executes (idempotency window expired). Never touches outcome —
            // the original request is still awaiting it.
            if (this.now() >= existing.expiresAt) {
                this.commandRecords.delete(key);
            } else if (existing.fingerprint !== fingerprint) {
                return err(
                    req.id,
                    ErrorCodes.CommandIdConflict,
                    "commandId was already used with different request parameters",
                );
            } else {
                return withRequestId(req.id, await existing.outcome);
            }
        }

        const turnKey = reg.options.turnStart ? getTurnKey(req.params) : undefined;
        if (turnKey && this.activeTurnCommands.has(turnKey)) {
            return err(
                req.id,
                ErrorCodes.SessionBusy,
                "a turn command is already active for this session",
            );
        }

        const outcome = this.executeRpcRequest(req, reg).then(toCommandOutcome);
        const record: CommandRecord = {
            fingerprint,
            outcome,
            settled: false,
            expiresAt: this.now() + this.commandRecordTtlMs,
        };
        this.commandRecords.set(key, record);
        void outcome.then(() => {
            record.settled = true;
            this.pruneCommandRecords();
        });
        if (turnKey) {
            this.activeTurnCommands.set(turnKey, outcome);
            void outcome.finally(() => {
                if (this.activeTurnCommands.get(turnKey) === outcome) {
                    this.activeTurnCommands.delete(turnKey);
                }
            });
        }
        return withRequestId(req.id, await outcome);
    }

    private async executeRpcRequest(
        req: RpcRequest,
        reg: NonNullable<ReturnType<typeof getRegisteredMethod>>,
    ): Promise<RpcResponse> {
        try {
            let workspace: WorkspaceRuntime | undefined;
            let cwd: WorkspaceId = "*";
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
                cwd = route;
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
                serverRegistry: this.serverRegistry,
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
    private resolveWorkspacePaths(cwd: WorkspaceId): {
        workspaceKey: WorkspaceId;
        fsCwd: string;
        sessionsRoot: string | undefined;
        isIm: boolean;
        disableFsTools: boolean;
        executionCwd: string;
        imPolicy?: ImWorkspacePolicy;
    } {
        // IM workspace: cwd may be the fsCwd (scratch path) when called from
        // executeRpcRequest — detect the IM URL pattern before the isIm branch.
        const parsedIm = cwd.startsWith(IM_CWD_PREFIX) ? parseImCwd(cwd) : undefined;
        const isIm = !!parsedIm;
        let workspaceKey = cwd;
        let fsCwd = cwd;
        let disableFsTools = false;
        let executionCwd = cwd;
        let imPolicy: ImWorkspacePolicy | undefined;
        let sessionsRoot = this.options.sessionsRoot;

        if (isIm && parsedIm) {
            sessionsRoot = makeImSessionsRoot(tacoHome(), parsedIm.channelId);
            fsCwd = join(sessionsRoot, "scratch");
            mkdirSync(fsCwd, { recursive: true });
            workspaceKey = cwd; // im:// URL for workspaceMap key + emitPush
            disableFsTools = true;
            // Register channel → workspace reverse index (for P2 single-channel restart)
            this.channelRegistry.trackWorkspace(parsedIm.channelId, cwd);

            // Resolve the workspace policy and where its tools actually run.
            imPolicy = this.imPolicyStore.resolve(parsedIm);
            const exec = resolveImExecutionCwd({ sessionsRoot, route: parsedIm, policy: imPolicy });
            executionCwd = exec.executionCwd;
            if (exec.warning) {
                log.warn(exec.warning);
            }
            const toolsGranted =
                imPolicy.tools.shell === "allow" || imPolicy.tools.fsTools === "allow";
            if (toolsGranted && exec.shared) {
                log.warn(
                    `IM chat ${cwd} now has local tools but shares ${executionCwd} with every other ` +
                        `chat on channel ${parsedIm.channelId} — set perChatScratch or a binding to isolate it.`,
                );
            }
        }

        return { workspaceKey, fsCwd, sessionsRoot, isIm, disableFsTools, executionCwd, imPolicy };
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
        const loaded = await loadSourcedSkills(
            skillEnv,
            defaultSkillDirs(fsCwd),
            (skill, source): TacoSkill => ({ ...skill, source }),
        );
        // pi's loadSourcedSkills does not dedupe internally; defaultSkillDirs
        // places .taco/skills first and builtin last, so dedupeSkillsByName
        // gives ".taco wins, builtin falls back" first-match semantics.
        const deduped = dedupeSkillsByNameWithDuplicates(loaded.skills.map((entry) => entry.skill));
        const skills = deduped.kept;
        preloadSkillFrontmatter(skills);
        // Stamp frontmatter-only fields (currently: inlineOnly) onto each
        // TacoSkill so skills.list can surface them. preloadSkillFrontmatter
        // must run first — readSkillFrontmatter returns from the cache. The
        // same pass lints the taco-private keys pi ignores, so a malformed
        // runAs/inlineOnly/allowedTools surfaces as a diagnostic here rather
        // than as a tool error at call time.
        const frontmatterDiagnostics: SkillDiagnosticEntry[] = [];
        for (const s of skills) {
            const fm = readSkillFrontmatter(s.filePath);
            if (fm.inlineOnly === true) {
                (s as TacoSkill).inlineOnly = true;
            }
            frontmatterDiagnostics.push(...checkSkillFrontmatter(fm, s.filePath));
        }
        // Logs stay: they are the only channel for headless / IM runs with no
        // client to read `skills.list`. The returned copy is additional, not a
        // replacement.
        //
        // `duplicate_name` is logged at info, not warn: a skill shadowed by a
        // same-named skill in another directory is expected (e.g. the same
        // skill under both ~/.claude/skills and ~/.taco/skills) and not a
        // degradation. The desktop forwards `[warn]` stderr lines to a toast,
        // so warn here would spam every boot. Loader/frontmatter diagnostics
        // stay warn — they signal genuinely broken skills.
        for (const dup of deduped.duplicates) {
            log.info(
                `skill duplicate_name at ${dup.dropped.filePath}: "${dup.name}" shadowed by ${dup.keptFrom.filePath}`,
            );
        }
        for (const d of loaded.diagnostics) {
            log.warn(`skill ${d.code} at ${d.path}: ${d.message}`);
        }
        for (const d of frontmatterDiagnostics) {
            log.warn(`skill ${d.code} at ${d.path}: ${d.message}`);
        }
        const diagnostics = [
            ...mapLoaderDiagnostics(loaded.diagnostics),
            ...mapDuplicateDiagnostics(deduped.duplicates),
            ...frontmatterDiagnostics,
        ];
        return { skills, diagnostics };
    }

    /**
     * Load workspace-scoped assets (skills, agents, extensions). All touch the
     * filesystem, so they are awaited before the synchronous WorkspaceRuntime
     * constructor.
     */
    private async loadWorkspaceAssets(
        fsCwd: string,
        isIm: boolean,
    ): Promise<{
        skills: TacoSkill[];
        skillDiagnostics: SkillDiagnosticEntry[];
        agents: AgentDefinition[];
        extensions?: Readonly<WorkspaceExtensionSet>;
    }> {
        const { skills, diagnostics: skillDiagnostics } = await this.loadSkills(fsCwd);

        // Load agents (builtin + user-defined). Same pattern as skills:
        // file I/O is awaited here.
        const builtinDir = join(resourceRoot(), "agents", "builtin");
        const agents = await loadAgents({ builtinDir, userDirs: defaultAgentDirs(fsCwd) });

        // Activate extensions: workspace activators are called here and
        // produce a frozen WorkspaceExtensionSet.
        const extensions = await activateExtensions(this.extensionRegistry, { cwd: fsCwd, isIm });

        return { skills, skillDiagnostics, agents, extensions };
    }

    /** For handlers / method layer — lazily created on first access */
    async ensureWorkspace(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        const cached = this.workspaceMap.get(cwd);
        if (cached) return cached;
        return this.workspaceFlight.run(cwd);
    }

    private async buildWorkspace(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        const paths = this.resolveWorkspacePaths(cwd);
        const { skills, skillDiagnostics, agents, extensions } = await this.loadWorkspaceAssets(
            paths.executionCwd,
            paths.isIm,
        );

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
        const workspaceCwdUsable = existsSync(paths.fsCwd);
        if (!workspaceCwdUsable && this.mcpServers.length > 0) {
            log.warn(
                `workspace dir missing (${paths.fsCwd}); stdio MCP servers without an explicit cwd will inherit the sidecar's`,
            );
        }
        const mcpProvider = await discoverMcpTools({
            servers: this.mcpServers.map((s) => ({
                ...s,
                ...(s.cwd !== undefined
                    ? { cwd: s.cwd }
                    : workspaceCwdUsable
                      ? { cwd: paths.fsCwd }
                      : {}),
            })),
            log,
        });
        const toolRegistry = new DefaultDeferredToolRegistry({
            candidates: mcpProvider.candidates(),
            dispose: () => mcpProvider.dispose(),
        });

        // From here on, any failure must dispose mcpProvider — its stdio
        // children / HTTP sockets outlive this scope otherwise. wireWorkspacePush
        // can throw on broken channel registries; WorkspaceRuntime's ctor can
        // throw on bad config; we don't get a second chance to release the
        // provider once it leaves this function.
        let ws: WorkspaceRuntime;
        try {
            ws = new WorkspaceRuntime({
                cwd: paths.fsCwd,
                workspaceKey: paths.workspaceKey,
                sessionsRoot: paths.sessionsRoot,
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
                agents,
                resources: { skills },
                skillDiagnostics,
                executionCwd: paths.executionCwd,
                imPolicy: paths.imPolicy,
                toolRegistry,
                // Hot-reload wiring: only the user-writable dirs are watched —
                // the builtin dir ships with the binary and only changes via
                // an app upgrade (a full restart), not hot-editing. Passing
                // both together is what makes WorkspaceRuntime opt into
                // watching; omitting either leaves reload off (e.g. tests that
                // construct WorkspaceRuntime directly without a live server).
                skillDirs: defaultSkillDirs(paths.executionCwd)
                    .filter((d) => d.source === "user")
                    .map((d) => d.path),
                reloadSkills: () => this.loadSkills(paths.executionCwd),
                // IM channel identity for the <im_channel> context tag — the
                // workspace only calls this for IM workspaces, passing the
                // route's channelId; peer/chat ids never reach it.
                resolveImChannel: (channelId) => this.resolveImChannel(channelId),
                // In-process self-RPC entry — used by the memory tool (and future
                // self-RPC tools).
                dispatchRpc: (req) => this.handleRpcRequest(req),
                // Pushes tasks.updated to the desktop TaskPanel — shares
                // emitPush with CompactionPushAdapter; sessionKind routing is
                // handled by emitPush's lookup of sessionKinds.
                taskPushAdapter: new TaskPushAdapter((method, workspace, session, params) =>
                    this.emitPush(method, workspace, session, params),
                ),
                planPushAdapter: new PlanPushAdapter((method, workspace, session, params) =>
                    this.emitPush(method, workspace, session, params),
                ),
            });

            this.wireWorkspacePush(ws, paths.workspaceKey);
        } catch (err) {
            // WorkspaceRuntime / push wiring failed. Dispose the provider
            // BEFORE rethrowing so its stdio children / HTTP sockets are
            // released. Single failure here is preferable to a leaked
            // process: every caller of ensureWorkspace sees the same error
            // and can retry.
            await mcpProvider.dispose().catch(() => undefined);
            throw err;
        }

        // Store keyed by workspaceKey (im:// URL for IM, fs path for IDE) so that
        // emitPush's IM_CWD_PREFIX branch fires correctly. All emitPush call sites
        // inside ensureWorkspace pass workspaceKey to this method, not cwd.
        //
        // set() must come AFTER ws is fully constructed but BEFORE any await
        // that yields control: if we yielded first, a concurrent
        // ensureWorkspace(cwd) could observe a half-built state (cache miss +
        // buildWorkspace already past the ctor) and start a second build that
        // would clobber this one in workspaceMap.set, leaking this ws's
        // mcpProvider. Putting set() here means a concurrent caller either
        // gets the fully-built ws from the cache or shares the SingleFlight
        // promise — never both.
        this.workspaceMap.set(paths.workspaceKey, ws);

        // If stop() ran while we were awaiting loadWorkspaceAssets /
        // discoverMcpTools / new WorkspaceRuntime / wireWorkspacePush, our
        // SingleFlight entry was cleared and workspaceMap was cleared, but
        // we are still about to publish a ws into a server that's been
        // told to shut down. Dispose and reject so no caller observes a
        // zombie.
        if (this.stopped) {
            this.workspaceMap.delete(paths.workspaceKey);
            await ws.dispose().catch(() => undefined);
            throw new Error(
                `sidecar stopped before workspace ${paths.workspaceKey} finished building`,
            );
        }

        // One-time notice when a chat's local tools are first enabled. Keyed by
        // workspaceKey (policy is per-chat), not sessionId, so a session switch
        // does not repeat the notice. Skipped for non-IM workspaces.
        if (paths.imPolicy) {
            const granted =
                paths.imPolicy.tools.shell === "allow" || paths.imPolicy.tools.fsTools === "allow";
            if (granted && !this.imPolicyStore.hasNotified(paths.workspaceKey)) {
                this.emitPush(PushMethods.ImToolsEnabled, paths.workspaceKey, undefined, {
                    text: imToolsEnabledNotice(this.clientUiLocale),
                });
                // The push already fired. A write failure must not surface as
                // an RPC error to the user (who already saw the notice) and
                // must not abort ensureWorkspace. The worst case is the
                // notice repeating after a sidecar restart, which is
                // acceptable.
                try {
                    await this.imPolicyStore.markNotified(paths.workspaceKey);
                } catch (e) {
                    log.warn(`markNotified failed for ${paths.workspaceKey}: ${e}`);
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
            // Branch: tool_execution_* split into named push methods
            // (session.tool_call_*); others stay as a blob in session.event.
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
            // session_before_compact / session_compact are a pair: the
            // former records t0 + tokensBefore, the latter computes the
            // duration and removes the in-flight record. The failure path
            // (never finished) is covered by maybeCompact throwing and a
            // timeout / Node-exit fallback; Desktop unfreezes and shows an
            // error toast when the finished frame has `failed: true`.
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
                const content = applyTuiVisibilityToContent(evt.message.content);
                if (isContentEmptyAfterVisibility(content)) return;
                this.emitPush(PushMethods.Event, workspaceKey, e.sessionId, {
                    event: { ...evt, message: { ...evt.message, content } },
                });
                return;
            }
            this.emitPush(PushMethods.Event, workspaceKey, e.sessionId, { event: e.event });
        });
        ws.permissionBroker.on("requested", (request) => {
            const [redacted] = redactCommandPermissionRequest(request);
            const routingSession = request.displaySessionId ?? request.sessionId;
            this.emitPush(
                PushMethods.CommandPermissionRequested,
                workspaceKey,
                routingSession,
                redacted,
            );
        });
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
        const ws = this.workspaceMap.get(cwd);
        if (!ws) return;
        await ws.dispose();
        this.workspaceMap.delete(cwd);
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
     * Without this, `ensureWorkspace` early-returns from the workspaceMap cache
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
            this.emitPush(PushMethods.ImWorkspacesInvalidated, key, undefined, {
                channelId,
                interruptedCount: 1,
            });
        }
        for (const key of keys) {
            await this.disposeWorkspace(key);
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
     * On a non-owner (daemon connection server), IM workspaces live on the
     * resident host — `invalidateImWorkspaces` against this server's empty
     * `workspaceMap` would silently do nothing, leaving stale policy on the
     * host until restart. Delegate the mutation + invalidate to the host,
     * then broadcast locally so the connection's own desktop still re-pulls.
     */
    async setImChannelDefault(
        channelId: string,
        patch: Parameters<ImWorkspacePolicyStore["setChannelDefault"]>[1],
    ): Promise<void> {
        if (!this.ownsChannels) {
            await this.imHost?.imPolicy?.setChannelDefault(channelId, patch);
            this.broadcastImPolicyChanged(channelId);
            return;
        }
        await this.imPolicyStore.setChannelDefault(channelId, patch);
        await this.invalidateImWorkspaces(channelId);
        this.broadcastImPolicyChanged(channelId);
    }

    async setImChatOverride(
        route: Parameters<ImWorkspacePolicyStore["setChatOverride"]>[0],
        patch: Parameters<ImWorkspacePolicyStore["setChatOverride"]>[1],
    ): Promise<void> {
        if (!this.ownsChannels) {
            await this.imHost?.imPolicy?.setChatOverride(route, patch);
            this.broadcastImPolicyChanged(route.channelId);
            return;
        }
        await this.imPolicyStore.setChatOverride(route, patch);
        await this.invalidateImWorkspaces(route.channelId);
        this.broadcastImPolicyChanged(route.channelId);
    }

    async clearImChatOverride(
        input: { route: ImRoute } | { chatKey: string },
        channelId: string,
    ): Promise<void> {
        if (!this.ownsChannels) {
            await this.imHost?.imPolicy?.clearChatOverride(input, channelId);
            this.broadcastImPolicyChanged(channelId);
            return;
        }
        if ("route" in input) {
            await this.imPolicyStore.clearChatOverride(input.route);
        } else {
            await this.imPolicyStore.clearChatOverrideByKey(channelId, input.chatKey);
        }
        await this.invalidateImWorkspaces(channelId);
        this.broadcastImPolicyChanged(channelId);
    }

    private pruneCommandRecords(): void {
        const now = this.now();
        // Expired records never count toward the limit and are freed eagerly
        // even when every survivor is in-flight — this is what bounds the map
        // when a handler never settles.
        for (const [key, record] of this.commandRecords) {
            if (now >= record.expiresAt) this.commandRecords.delete(key);
        }
        const limit = this.options.commandRecordLimit ?? 1024;
        while (this.commandRecords.size > limit) {
            const oldestSettled = [...this.commandRecords.entries()].find(
                ([, record]) => record.settled,
            )?.[0];
            if (!oldestSettled) return;
            this.commandRecords.delete(oldestSettled);
        }
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
        for (const ws of this.workspaceMap.values()) {
            ws.setCustomProviders(next);
        }
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
        for (const ws of this.workspaceMap.values()) {
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
        for (const ws of this.workspaceMap.values()) {
            ws.invalidateCompactionCache();
        }
    }

    /**
     * Dispose + clear every workspace so the next `ensureWorkspace` rebuilds
     * against the latest disk config. Called by the `mcp.*` mutation handlers
     * after persisting a change so newly enabled / removed MCP servers are
     * discovered on demand instead of requiring a sidecar restart. Active
     * chat sessions in those workspaces are interrupted — acceptable for a
     * rare config mutation.
     */
    async reloadMcpServers(): Promise<void> {
        // Refresh the cached snapshot so the next ensureWorkspace discovers
        // newly enabled / removed servers. Mirrors setCustomProviders /
        // setDefaultModel: invalidate-then-propagate, so the disk read happens
        // once per mcp mutation rather than on every ensureWorkspace. The three
        // mcp.* mutation handlers are the only callers.
        this.mcpServers = readGlobalConfig().mcpServers ?? [];
        for (const ws of this.workspaceMap.values()) {
            await ws.dispose();
        }
        this.workspaceMap.clear();
    }

    /**
     * Hot-reload the `InstructionsConfig` for every workspace. Each
     * workspace's sessionRegistry re-reads via a lazy thunk on the next LLM
     * call — no per-session invalidation needed. Called from the
     * `settings.write` handler after writing the `instructions` field.
     *
     * The instance field write mirrors `setCustomProviders` / `setDefaultModel`:
     * without it, a server with zero built workspaces (e.g. `schedulerSidecar`
     * before any job has fired) would silently drop the patch — the next
     * `ensureWorkspace` would read the stale boot-time value from
     * `buildWorkspace`.
     */
    refreshInstructions(next: InstructionsConfig | undefined): void {
        this.instructionsConfig = next;
        for (const ws of this.workspaceMap.values()) {
            ws.updateInstructionsConfig(next);
        }
    }

    /** IM channel control surface consumed by the `channels.*` handlers. */
    readonly channels: ChannelControl = {
        list: (): ChannelsListResult => ({
            available: BUILTIN_CHANNEL_MANIFESTS.map((m) => ({
                name: m.name,
                version: m.version,
                description: m.description,
                maxMessageLength: m.capabilities.maxMessageLength,
                requiresPersistentProcess: m.capabilities.requiresPersistentProcess ?? false,
                approvalButton: m.capabilities.approvalButton ?? false,
            })),
            configured: this.channelConfigs.map((cfg) =>
                this.toStatusEntry(this.channelBindBroker.status(cfg.channelId), cfg),
            ),
            failed: [...this.failedChannels],
        }),
        // conversationRouter may be unset before start() finishes; treat that
        // as "no conversations yet" rather than throwing — listConversations
        // is a process-level query, not a precondition for IM to function.
        listConversations: (channelId) => ({
            conversations: this.conversationRouter?.listAll(channelId) ?? [],
        }),
        create: (name, channelId): ChannelsCreateResult => {
            const manifest = BUILTIN_CHANNEL_MANIFESTS.find((m) => m.name === name);
            if (!manifest) throw new Error(`unknown channel type: ${name}`);
            const id = channelId ?? name;
            if (!isValidChannelId(id)) throw new Error(`invalid channelId: ${id}`);

            // Read from disk rather than this.channelConfigs: another writer may
            // have added an instance since startup, and saveGlobalConfig
            // replaces the whole array.
            const existing = readGlobalConfig().channels ?? [];
            if (existing.some((c) => c.channelId === id)) {
                throw new Error(`channelId already exists: ${id}`);
            }
            saveGlobalConfig({
                channels: [
                    ...existing,
                    {
                        channelId: id,
                        manifest: {
                            name: manifest.name,
                            version: manifest.version,
                        },
                        config: {},
                    },
                ],
            });
            // Channels load statically at startup (same as extensions), so the
            // new instance is not bindable until the sidecar restarts.
            return { channelId: id, requiresRestart: true };
        },
        bind: async (channelId, force): Promise<ChannelsBindResult> => {
            const cfg = this.channelConfigs.find((c) => c.channelId === channelId);
            if (!cfg) throw new Error(`unknown channelId: ${channelId}`);
            if (!this.channelRegistry.has(channelId)) {
                throw new Error(`channel ${channelId} is not running`);
            }
            // Login is deliberately not awaited: the QR flow needs many
            // seconds of human interaction, and progress is reported through
            // `channel.status_changed` pushes instead.
            void this.channelRegistry.login(channelId, force).catch((e: unknown) => {
                const message = e instanceof Error ? e.message : String(e);
                log.error(`channel ${channelId} bind failed: ${message}`);
                this.channelBindBroker.setState(channelId, "error", { message });
            });
            return { channelId, state: this.channelBindBroker.status(channelId).state };
        },
        submitVerifyCode: (requestId, code) =>
            this.channelBindBroker.submitVerifyCode(requestId, code),
        unbind: async (channelId) => {
            if (!this.channelConfigs.some((c) => c.channelId === channelId)) {
                throw new Error(`unknown channelId: ${channelId}`);
            }
            await this.channelRegistry.logout(channelId);
            this.channelBindBroker.reset(channelId);
        },
    };

    /** IM workspace policy control surface consumed by the `imPolicy.*` handlers. */
    readonly imPolicy: ImPolicyControl = {
        get: (params) => {
            const channelId = params.channelId;
            const doc = this.imPolicyStore.readDocument(channelId);
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
            return {
                channelId,
                channelDefault: doc.default ?? {},
                resolved,
                chatOverride,
                hasOverride: chatOverride !== null,
                overrides,
            };
        },
        setChannelDefault: (channelId, patch) => this.setImChannelDefault(channelId, patch),
        setChatOverride: (route, patch) => this.setImChatOverride(route, patch),
        clearChatOverride: (input, channelId) => this.clearImChatOverride(input, channelId),
    };

    /** Fans a channel binding transition out to every workspace. Binding is
     *  process-level, but push frames are workspace-routed, so each open
     *  workspace gets a copy — the client dedupes by channelId. IM workspaces
     *  are skipped for the same reason as broadcastConversationsChanged: they
     *  scale with conversation count and never render the Channels pane. */
    broadcastChannelStatus(channel: ChannelStatusEntry): void {
        for (const cwd of this.workspaceMap.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ChannelStatusChanged, cwd, undefined, { channel });
        }
    }

    /**
     * Broker frames carry only the transition fields (channelId/state/QR/...).
     * The wire entry also needs the config-derived name and the on-disk
     * configured flag, so the push payload matches `channels.list` output and
     * the client's wholesale entry replacement stays consistent.
     */
    private toStatusEntry(status: ChannelBindStatus, cfg?: ChannelConfig): ChannelStatusEntry {
        const config = cfg ?? this.channelConfigs.find((c) => c.channelId === status.channelId);
        return {
            channelId: status.channelId,
            name: config?.manifest.name ?? status.channelId,
            state: status.state,
            // Probed from disk, not derived from state: the contract is
            // "credentials are stored, regardless of connectivity", so an
            // errored/expired binding still reports true and the UI offers
            // Rebind instead of Bind.
            configured: hasStoredCredentials(status.channelId),
            qrUrl: status.qrUrl,
            requestId: status.requestId,
            retry: status.retry,
            message: status.message,
        };
    }

    /**
     * Resolve a configured channel instance id to its safe IM channel identity
     * for the `<im_channel>` context tag. Deliberately minimal — only platform
     * type (manifest name) + instance id. No bind state, no configuration
     * contents, no credentials, no peer/chat identifiers. Unknown ids → undefined.
     * Read from the current `channelConfigs` on every call so a settings.write
     * reconfiguration is reflected on the next LLM turn.
     */
    private resolveImChannel(channelId: string): ImChannelContext | undefined {
        const cfg = this.channelConfigs.find((c) => c.channelId === channelId);
        if (!cfg) return undefined;
        return { type: cfg.manifest.name, channelId: cfg.channelId };
    }

    /** Invalidate notification for `channels.listConversations`. Triggered by
     *  ConversationRouter when a NEW session is created (not on every inbound
     *  message). Empty payload — desktop re-pulls the conversation list.
     *
     *  IM workspaces are skipped: workspaceMap is keyed by workspaceKey, so
     *  every routed conversation occupies a slot. Fanning out to those too
     *  would make the push count grow with conversation count, and each copy
     *  costs the client a full listConversations re-pull. Only real (fs)
     *  workspaces host the Channels pane that consumes this. */
    broadcastConversationsChanged(): void {
        for (const cwd of this.workspaceMap.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ConversationsChanged, cwd, undefined, {});
        }
    }

    broadcastModelsChanged(): void {
        // Workspace-dimensioned push (no session) — desktop re-pulls
        // providers.list / session.listModels for this workspace. IM workspaces
        // don't render a model picker, so skip them like the other broadcasts.
        for (const cwd of this.workspaceMap.keys()) {
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
        for (const cwd of this.workspaceMap.keys()) {
            if (cwd.startsWith(IM_CWD_PREFIX)) continue;
            this.emitPush(PushMethods.ImPolicyChanged, cwd, undefined, { channelId });
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
        // (see ServerPush.sessionKind). Look up the runtime's sessionKinds
        // map synchronously; frames without a session dimension leave it
        // empty.
        const sessionKind =
            session !== undefined
                ? this.workspaceMap.get(workspace)?.getSessionKind(session)
                : undefined;
        const frame =
            session === undefined
                ? makePushFrame({ method, workspace, session, sessionKind, params, id })
                : this.sessionEvents.append(workspace, session, (seq) =>
                      makePushFrame({ method, workspace, session, sessionKind, seq, params, id }),
                  );
        void this.getTransport().send(frame);
        // im:// workspaces additionally fan-out channel pushes (additive sink; no return; stdio always sends)
        if (workspace.startsWith(IM_CWD_PREFIX)) {
            const parsed = parseImCwd(workspace);
            if (parsed) this.channelRegistry.push(parsed.channelId, frame);
            // Phase 2: deliver the same frame to every connected desktop's
            // transport so an already-open IM session view sees real-time
            // peer messages / mid-turn updates. Fanout is unconditional —
            // each desktop filters frames by session id at the app layer,
            // so a frame addressed to one im:// workspace reaches every
            // sink and the irrelevant ones are dropped downstream. Gated on
            // `parsed` to skip malformed im:// strings that can't identify
            // a channel.
            if (parsed) this.clientSinkRegistry?.fanout(frame);
        }
    }
}

/**
 * Shared dependencies for spawning one SidecarServer per NDJSON socket
 * connection. The bundle's daemon mode (see `src/index.ts`) loads
 * config + extensions once, then calls `startServer(sharedDeps, transport)`
 * for each accepted connection. Per-connection servers are intentional —
 * channels (WeChat etc.) and workspace state are connection-scoped, and
 * a UI that disconnects then reconnects gets a fresh handshake rather than
 * inheriting a dead socket.
 *
 * In daemon mode the connection-scoped fields above are joined by a
 * process-level channel stack (registry / broker / router / imHost)
 * injected by `runDaemon`. Receiving these four as a unit ensures a
 * missing `imHost` is treated as "owner" rather than a half-configured
 * non-owner.
 */
export interface SharedSidecarDeps {
    sessionsRoot: string;
    defaultModel?: string;
    defaultProvider?: string;
    systemPrompt?: string;
    defaultThinkingLevel?: ThinkingLevel;
    compaction?: ResolvedCompaction;
    memoryEnabled?: boolean;
    /**
     * Project-context instructions injection (CLAUDE.md / AGENTS.md /
     * DESIGN.md). Mirrors `SidecarServerOptions.instructionsConfig` —
     * plumbed from `cfg.instructions` in `index.ts → toSharedSidecarDeps`.
     */
    instructionsConfig?: InstructionsConfig;
    extensionRegistry?: ExtensionRegistry;
    providerKeyStore: ProviderKeyStore;
    customProviders?: readonly CustomProviderConfig[];
    mcpServers?: readonly McpServerConfig[];
    channels?: readonly ChannelConfig[];
    /**
     * Scheduler control surface — same instance is shared across every
     * per-connection SidecarServer so jobs.create/update/delete mutate
     * the single process-wide scheduler.
     */
    jobs?: JobsControl;
    /**
     * Process-level IM channel stack. Populated by `runDaemon` so every
     * NDJSON connection server becomes a non-owner (see SidecarServerOptions
     * ownership rule). Empty on the stdio single-process sidecar.
     */
    channelRegistry?: ChannelRegistry;
    channelBindBroker?: ChannelBindBroker;
    conversationRouter?: ConversationRouter;
    /** Daemon-resident IM host — see SidecarServerOptions.imHost. */
    imHost?: ServerRpcSurface;
    /**
     * Process-level client-sink fan-out registry (Phase 2). Populated by
     * `runDaemon` so every NDJSON connection server registers its transport
     * and the resident can push IM frames to every connected desktop.
     */
    clientSinkRegistry?: ClientSinkRegistry;
    /**
     * Process-level server-side fan-out registry for `settings.write`
     * setters. Populated by `runDaemon`; omitted on stdio / tests.
     */
    serverRegistry?: ServerRegistry;
}

/**
 * Create a fresh SidecarServer over the given transport and start it.
 *
 * Returns both the server handle (so callers can stop it on socket close)
 * and a Promise that resolves once the transport has been opened. The
 * returned disposer stops the server.
 *
 * This is the bridge between `src/index.ts` daemon-mode entry (which
 * accepts NDJSON socket connections) and `SidecarServer.start` (which
 * owns the actual NDJSON read/write over one transport). Adding a thin
 * factory keeps the daemon wiring in one place and lets the per-connection
 * server be garbage-collected when its socket closes.
 */
export interface StartedSidecar {
    server: SidecarServer;
    ready: Promise<void>;
    stop: () => Promise<void>;
}

export function startServer(deps: SharedSidecarDeps, transport: Transport): StartedSidecar {
    const server = new SidecarServer({
        sessionsRoot: deps.sessionsRoot,
        defaultModel: deps.defaultModel,
        defaultProvider: deps.defaultProvider,
        systemPrompt: deps.systemPrompt,
        defaultThinkingLevel: deps.defaultThinkingLevel,
        compaction: deps.compaction,
        memoryEnabled: deps.memoryEnabled,
        instructionsConfig: deps.instructionsConfig,
        extensionRegistry: deps.extensionRegistry,
        providerKeyStore: deps.providerKeyStore,
        customProviders: deps.customProviders,
        mcpServers: deps.mcpServers,
        channels: deps.channels,
        jobs: deps.jobs,
        channelRegistry: deps.channelRegistry,
        channelBindBroker: deps.channelBindBroker,
        conversationRouter: deps.conversationRouter,
        imHost: deps.imHost,
        clientSinkRegistry: deps.clientSinkRegistry,
        serverRegistry: deps.serverRegistry,
    });
    const ready = server.start(transport);
    return {
        server,
        ready,
        stop: async () => {
            await server.stop();
        },
    };
}
