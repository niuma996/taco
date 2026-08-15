/**
 * WorkspaceRuntime — facade for a single workspace's runtime.
 *
 * Resolves readonly config at construction, then assembles and wires three
 * components, passing public methods through 1:1:
 *  - SessionRegistry: session CRUD + attach/detach + event fan-out
 *  - AgentSpawner: subagent spawn + skill subagent
 *  - ModelRegistry: model switching + provider key hot-update
 */

import { EventEmitter } from "node:events";
import { resolve as resolvePath } from "node:path";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    JsonlSessionMetadata,
    PromptTemplate,
    SessionTreeEntry,
    ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/compat";
import type {
    CustomProviderConfig,
    InstructionsConfig,
    RpcRequest,
    RpcResponse,
    SessionId,
    SupportedLocale,
    WorkspaceId,
} from "@taco-ai/protocol";
import { IM_CWD_PREFIX, parseImCwd } from "@taco-ai/protocol";
import type { AgentDefinition } from "../agents/types.ts";
import {
    DEFAULT_IM_WORKSPACE_POLICY,
    type ImWorkspacePolicy,
} from "../channels/imWorkspacePolicy.ts";
import { CheckpointManager } from "../checkpoints/manager.ts";
import type { CheckpointMeta, RestoreOutcome } from "../checkpoints/store.ts";
import { CheckpointStore } from "../checkpoints/store.ts";
import type { ResolvedCompaction } from "../config/config.ts";
import {
    defaultSessionsRoot,
    readGlobalConfig,
    validateCommandPermissions,
} from "../config/config.ts";
import { renderInstructionBlock, resolveInstructions } from "../config/instructions.ts";
import type { WorkspaceExtensionSet } from "../extensions/index.ts";
import { createLogger } from "../lib/logger.ts";
import type { MemoryStore } from "../memory/index.ts";
import { LocalMemoryStore, NoOpMemoryStore } from "../memory/index.ts";
import { PermissionBroker } from "../permissions/permissionBroker.ts";
import {
    NoopPlanPushAdapter,
    type PlanPushAdapter,
    type PlanSnapshotPublisher,
} from "../plan/planPushAdapter.ts";
import {
    buildSystemPrompt,
    formatSkillsForSystemPrompt,
    projectContextForPrompt,
    type SystemPromptContributor,
} from "../prompts/index.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import type { ImChannelContext } from "../tags/index.ts";
import {
    NoopTaskPushAdapter,
    type TaskPushAdapter,
    type TaskSnapshotPublisher,
} from "../tasks/taskPushAdapter.ts";
import { defaultToolsWithTasks, type MemoryToolDeps, type TacoTool } from "../tools/index.ts";
import { AgentSpawner, findModelById } from "./agentSpawner.ts";
import type { AttachedSession } from "./attachedSession.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import { DefaultDeferredToolRegistry } from "./deferredToolRegistry.ts";
import type { ModelInfo, ProviderInfo } from "./modelRegistry.ts";
import { applyBuiltinProviders, ModelRegistry } from "./modelRegistry.ts";
import type { ProviderKeyStore } from "./providerKeyStore.ts";
import { type AttachOptions, SessionRegistry } from "./sessionRegistry.ts";
import type { SessionTaskState } from "./sessionTaskState.ts";
import { dedupOverride, filterToolsForImPolicy } from "./toolAssembly.ts";

const log = createLogger("workspace");

export type { AttachOptions, ModelInfo };

export interface WorkspaceRuntimeOptions {
    cwd: WorkspaceId;
    /** Session persistence root; defaults to $TACO_HOME/sessions (~/.taco/sessions). */
    sessionsRoot?: string;
    /** Default model — either a string id or a Model object. */
    defaultModel?: string | Model<Api>;
    /** Default provider id (scopes model lookup to that provider). */
    defaultProvider?: string;
    /** Custom model registry. */
    models?: MutableModels;
    /** Custom system prompt. */
    systemPrompt?: string;
    /**
     * Instructions injection config (CLAUDE.md / AGENTS.md / DESIGN.md).
     * `undefined` = use defaults (all enabled except DESIGN.md).
     * The hook reads this lazily via the `getInstructionsConfig` thunk on
     * every LLM call, so a `settings.write` patch takes effect without
     * rebuilding the workspace.
     */
    instructionsConfig?: InstructionsConfig;
    /**
     * Resolver from a configured channel instance id to its safe IM channel
     * identity (platform type + instance id). Supplied by the server; the
     * workspace only calls it for IM workspaces, passing the channelId from
     * its im:// route. Returns `undefined` for unknown ids. `peerId` / `chatId`
     * never reach the resolver — the boundary is enforced here.
     */
    resolveImChannel?: (channelId: string) => ImChannelContext | undefined;
    /** Custom toolset. */
    tools?: TacoTool[];
    /** Custom resources (skill / prompt template). */
    resources?: AgentHarnessResources<TacoSkill, PromptTemplate>;
    /** Custom stream options. */
    streamOptions?: AgentHarnessStreamOptions;
    /** Default thinking level for new AttachedSessions; overridable via `attach(opts)`. */
    defaultThinkingLevel?: ThinkingLevel;
    /** Auto-compaction policy; every AttachedSession references this same resolved config. */
    compaction?: ResolvedCompaction;
    /**
     * Per-workspace extension contributions, produced by `activateExtensions`.
     * Holds a frozen snapshot of all contributions active in this workspace.
     * `undefined` when no extensions are configured.
     *
     * The extension registry is process-level and MUST NOT be held by
     * `WorkspaceRuntime` — workspace-level contributions come through here.
     */
    readonly extensions?: Readonly<WorkspaceExtensionSet>;
    /** Subagent definitions (loaded and injected by server.ts); [] = no subagents available. */
    agents?: AgentDefinition[];
    /**
     * UI locale fallback used by the reply_language hook when prompt/steer carries
     * no explicit uiLocale. Unset means the hook injects no <reply_language> tag.
     */
    defaultUiLocale?: SupportedLocale;
    /**
     * Process-level API key store. Required — ModelRegistry derives startup
     * setProvider from store state and hot-updates on store change events.
     * Production builds it unconditionally (see `SidecarServer`); tests
     * pass a fresh `ProviderKeyStore({})` or one seeded with the keys the
     * case needs. We never fall back to `process.env` so the test surface
     * cannot be influenced by ambient shell state.
     */
    providerKeyStore: ProviderKeyStore;
    /** Custom provider configs (registered into the catalog alongside built-ins). */
    customProviders?: readonly CustomProviderConfig[];
    /** Enable user-level memory. Default = enabled. */
    memoryEnabled?: boolean;
    /** Entry point for `tasks.updated` pushes; defaults to NoopTaskPushAdapter. */
    taskPushAdapter?: TaskPushAdapter;
    /** Entry point for `plan.state.updated` pushes; defaults to NoopPlanPushAdapter. */
    planPushAdapter?: PlanPushAdapter;
    /** Routing key (im:// virtual key); defaults to fsCwd. Used only as workspaceMap key / push frame workspace field. */
    workspaceKey?: string;
    /** Real fs cwd for IM workspace (scratch root). IDE paths are resolved via resolvePath(cwd). */
    fsCwd?: string;
    /** Pass true for IM workspaces to remove fs/process-class tools. */
    disableFsTools?: boolean;
    /**
     * Resolved IM workspace policy. Absent for non-IM workspaces (nothing
     * filtered). When present, `executionCwd` is used for tool execution
     * while `sessionCwd` (the fsCwd) stays the storage identity.
     */
    imPolicy?: ImWorkspacePolicy;
    /** Where tools run (shell, fs tools, plan files). Defaults to the session cwd. */
    executionCwd?: string;
    /**
     * In-process self-RPC entry (injected by SidecarServer) so
     * `defaultToolsWithTasks` can build `MemoryToolDeps.call`.
     * Omitted means the memory tool is not wired.
     */
    dispatchRpc?: (req: RpcRequest) => Promise<RpcResponse>;
    /**
     * Dynamic-tool candidate directory. When provided, each attached session wires
     * a resident AddTools tool and can load deferred candidates on demand.
     * Defaults to an empty directory (no dynamic-tool capability).
     */
    toolRegistry?: DeferredToolRegistry;
}

export class WorkspaceRuntime extends EventEmitter {
    /** Session storage identity — the cwd JsonlSessionRepo partitions by. Never
     *  changes once a workspace exists (moving it would hide all JSONL). */
    readonly sessionCwd: WorkspaceId;
    /** Where shell / fs tools and plan files run. May differ from sessionCwd
     *  for IM workspaces whose policy binds a local directory or per-chat scratch. */
    readonly executionCwd: WorkspaceId;
    readonly workspaceKey: string;
    readonly sessionsRoot: string;
    /** Execution environment — cwd is executionCwd. */
    readonly env: NodeExecutionEnv;
    /** Session storage environment — cwd is sessionCwd. Serves JsonlSessionRepo. */
    readonly sessionEnv: NodeExecutionEnv;
    readonly repo: JsonlSessionRepo;
    readonly models: MutableModels;
    // Mutable: settings.write hot-reloads the default model when the user
    // picks a provider/model after the sidecar is already running. See
    // setDefaultModel — without live update, session.create would keep using
    // the construction-time fallback (first catalog model) and fail with
    // "Provider is not configured" for the unconfigured fallback provider.
    defaultModel?: Model<Api>;
    readonly systemPrompt: string;
    readonly tools: TacoTool[];
    readonly resources: AgentHarnessResources<TacoSkill, PromptTemplate>;
    readonly streamOptions: AgentHarnessStreamOptions;
    /**
     * Rendered parent instructions block (CLAUDE.md / AGENTS.md / DESIGN.md)
     * inherited by subagents at spawn time via the rebuilt system prompt so
     * the parent's project rules apply in the child session too. Empty when
     * no instructions are enabled or no files match the priority chain.
     *
     * NOT readonly: `updateInstructionsConfig()` recomputes this so a
     * settings.write that toggles `inheritToSubagents` or flips a file
     * enable takes effect on the next subagent spawn, not only on next
     * workspace attach.
     */
    parentInstructionsBlock: string;
    /**
     * Current `InstructionsConfig` for the instructions context hook. Read
     * lazily by `getInstructionsConfig()` (injected into SessionRegistry)
     * so a `settings.write` patch takes effect on the next LLM call without
     * re-attaching sessions. `updateInstructionsConfig()` swaps this in.
     */
    instructionsConfig: InstructionsConfig | undefined;
    readonly defaultThinkingLevel?: ThinkingLevel;
    /**
     * Per-workspace extension contributions, produced by `activateExtensions`.
     * `undefined` when no extensions are configured.
     */
    readonly extensions?: Readonly<WorkspaceExtensionSet>;
    /** UI locale fallback; see WorkspaceRuntimeOptions.defaultUiLocale. */
    readonly defaultUiLocale?: SupportedLocale;
    /**
     * Auto-compaction policy (one shared ResolvedCompaction for all instances),
     * passed to every AttachedSession. `undefined` means the sidecar gave no
     * config and AttachedSession uses its own default (true / 0.7).
     */
    readonly compaction?: ResolvedCompaction;
    /** User-level memory store. */
    readonly memoryStore: MemoryStore;
    /** Pre-write snapshots for this workspace; undefined when FS tools are off. */
    readonly checkpointStore: CheckpointStore | undefined;
    readonly permissionBroker: PermissionBroker;
    /** Dynamic-tool candidate directory (enables AddTools when present). */
    readonly toolRegistry: DeferredToolRegistry;

    /**
     * Workspace task push adapter — server calls publishCurrentTaskSnapshot on
     * `session.attached` so attaching an old session immediately shows its tasks.
     *
     * The task store / planState themselves are per-session (see
     * AttachedSession.taskStore); the adapter is session-agnostic and lives here.
     */
    readonly taskAdapter: TaskSnapshotPublisher;
    /**
     * Workspace plan push adapter — the plan tool pushes snapshots on state change.
     * Session-agnostic; the caller injects the concrete sessionId.
     */
    readonly planAdapter: PlanSnapshotPublisher;

    /** The three delegate components behind this facade. */
    readonly sessionRegistry: SessionRegistry;
    readonly agentSpawner: AgentSpawner;
    readonly modelRegistry: ModelRegistry;

    /** Subagent definition registry; passes through `agentSpawner.agents`. */
    get agents(): AgentDefinition[] {
        return this.agentSpawner.agents;
    }

    /** IM routing triple, parsed from workspaceKey (im:// URL) if this is an IM workspace. */
    get imRouting(): { channelId: string; peerId: string; chatId: string } | undefined {
        const parsed = parseImCwd(this.workspaceKey);
        return parsed
            ? { channelId: parsed.channelId, peerId: parsed.peerId, chatId: parsed.chatId }
            : undefined;
    }

    constructor(options: WorkspaceRuntimeOptions) {
        super();
        const isIm = options.cwd.startsWith(IM_CWD_PREFIX);
        // IM channel identity resolver is only meaningful for IM workspaces.
        // Capture the route's channelId once (workspaceKey is immutable for the
        // workspace's lifetime) so the im_channel thunk never needs imRouting
        // and peerId/chatId stay out of the prompt path entirely.
        // Use options.workspaceKey if already supplied, otherwise fall back to
        // options.cwd for IM routing before this.workspaceKey is assigned.
        const imRoute = isIm ? parseImCwd(options.workspaceKey ?? options.cwd) : undefined;
        const imChannelId = imRoute?.channelId;
        // sessionCwd: IM uses the scratch root; IDE resolves to a real fs path.
        // workspaceKey is stored separately for push frame / parseImCwd routing.
        // sessionCwd is the storage identity and MUST NOT change once a session
        // exists — JsonlSessionRepo partitions by it (encodeCwd).
        this.sessionCwd = isIm
            ? (options.fsCwd ?? resolvePath(options.cwd))
            : resolvePath(options.cwd);
        // executionCwd is a soft association: where shell/fs tools run. It may
        // be repointed by IM policy (local binding / per-chat scratch) without
        // affecting session storage.
        this.executionCwd = options.executionCwd
            ? resolvePath(options.executionCwd)
            : this.sessionCwd;
        this.workspaceKey = options.workspaceKey ?? this.sessionCwd;
        this.sessionsRoot = defaultSessionsRoot(options.sessionsRoot);
        // Two envs so storage identity and execution location cannot drift.
        this.sessionEnv = new NodeExecutionEnv({ cwd: this.sessionCwd });
        this.env = new NodeExecutionEnv({ cwd: this.executionCwd });
        this.repo = new JsonlSessionRepo({ fs: this.sessionEnv, sessionsRoot: this.sessionsRoot });

        // Model catalog: use the caller's if given, otherwise build an empty one and
        // let applyBuiltinProviders register into it. Credentials come from
        // ProviderKeyStore (a pi CredentialStore) so pi reads keys lazily by provider
        // id rather than via env-name mapping.
        this.models = options.models ?? createModels({ credentials: options.providerKeyStore });
        if (!options.models) {
            // Register all built-in + custom providers here so the defaultModel
            // lookup below can resolve. ModelRegistry's constructor skips its own
            // registration (registerProviders=false) when we did it here.
            applyBuiltinProviders(this.models, undefined, options.customProviders);
        }
        // The harness falls back to getDefaultStreamFn(); without this registration the
        // first prompt throws "No default stream function configured".
        setDefaultStreamFn(this.models.streamSimple);

        // defaultModel resolution — never throws on a bad id.
        //
        // If defaultModel is missing or invalid, log a warning and leave it
        // undefined. A throw here would lock the user out of the UI (no way
        // to fix a stale model id in taco.json) — session.create surfaces
        // the explicit invalid_state error instead.
        let defaultModel: Model<Api> | undefined;
        if (options.defaultModel) {
            if (typeof options.defaultModel === "string") {
                // Prefer lookup under defaultProvider to avoid colliding with a
                // same-named model id from another provider.
                const found = options.defaultProvider
                    ? this.models.getModel(options.defaultProvider, options.defaultModel)
                    : findModelById(this.models, options.defaultModel);
                if (!found) {
                    const label = options.defaultProvider
                        ? `${options.defaultProvider}/${options.defaultModel}`
                        : options.defaultModel;
                    log.error(
                        `default model "${label}" not found in catalog — starting without a default model. Configure a provider and model in Settings.`,
                    );
                }
                defaultModel = found;
            } else {
                defaultModel = options.defaultModel;
            }
        } else {
            const all = this.models.getModels();
            if (all.length > 0) defaultModel = all[0];
        }
        this.defaultModel = defaultModel;

        // extensions (per-workspace) must be assigned before tools / systemPrompt are built.
        this.extensions = options.extensions;

        // Session-agnostic task push adapter: mutation tools and
        // publishCurrentTaskSnapshot both push tasks.updated through it. The task
        // store / planState are per-session, hydrated at attach time.
        const taskAdapter: TaskSnapshotPublisher =
            options.taskPushAdapter ?? new NoopTaskPushAdapter();
        this.taskAdapter = taskAdapter;

        // Session-agnostic plan push adapter: planEnter/planExit push
        // plan.state.updated through it; the caller injects the sessionId.
        const planAdapter: PlanSnapshotPublisher =
            options.planPushAdapter ?? new NoopPlanPushAdapter();
        this.planAdapter = planAdapter;

        const ephemeralTaskState: SessionTaskState = {
            taskStore: { currentListId: null, lists: new Map() },
            planState: { active: false, currentSlug: null },
            tasksDir: "",
        };
        const memoryDeps = makeMemoryDeps(options.dispatchRpc, this.sessionCwd);
        this.toolRegistry =
            options.toolRegistry ?? new DefaultDeferredToolRegistry({ candidates: [] });
        const imPolicy =
            options.imPolicy ?? (options.disableFsTools ? DEFAULT_IM_WORKSPACE_POLICY : undefined);
        this.permissionBroker = new PermissionBroker(
            () => validateCommandPermissions(readGlobalConfig().commandPermissions, "taco.json"),
            {
                resolveDisplayContext: (sid) => this.sessionRegistry.resolveDisplayContext(sid),
                imCommandPolicy: () => imPolicy?.commands,
            },
        );
        const baseTools =
            options.tools ??
            defaultToolsWithTasks(
                ephemeralTaskState.taskStore,
                ephemeralTaskState.tasksDir,
                ephemeralTaskState.planState,
                this.executionCwd,
                taskAdapter,
                planAdapter,
                "",
                memoryDeps,
                this.permissionBroker,
            );
        const extTools = this.extensions?.toolsWithSource() ?? [];
        const merged = extTools.length > 0 ? dedupOverride(baseTools, extTools) : baseTools;
        this.tools = imPolicy ? filterToolsForImPolicy(merged, imPolicy) : merged;

        // Per-session tool factory: at attach time, rebuild the task tools against
        // that session's hydrated taskState so pushes route to the right session and
        // each session owns an independent store / planState.
        const toolsBuilder = (sessionId: SessionId, taskState: SessionTaskState): TacoTool[] => {
            const perSession =
                options.tools ??
                defaultToolsWithTasks(
                    taskState.taskStore,
                    taskState.tasksDir,
                    taskState.planState,
                    this.executionCwd,
                    taskAdapter,
                    planAdapter,
                    sessionId,
                    memoryDeps,
                    this.permissionBroker,
                );
            const perSessionMerged =
                extTools.length > 0 ? dedupOverride(perSession, extTools) : perSession;
            return imPolicy ? filterToolsForImPolicy(perSessionMerged, imPolicy) : perSessionMerged;
        };
        this.resources = options.resources ?? {};
        // The system prompt always uses the built-in template (assembled from the
        // current toolset + platform) and can no longer be overridden by config.
        // A configured systemPrompt is appended after it — not silently dropped,
        // but unable to replace or override the system base.
        const contributors: SystemPromptContributor[] = [];
        if (options.systemPrompt) contributors.push({ append: options.systemPrompt });
        // git-context guidance (if cwd is a git repo) comes through
        // activateExtensions → WorkspaceExtensionSet.systemPromptContributors(), which
        // runs before external contributors — this ordering is preserved.
        contributors.push(...(this.extensions?.systemPromptContributors() ?? []));
        // Only append the <available_skills> section when resources.skills is
        // non-empty; formatSkillsForSystemPrompt already filters
        // disableModelInvocation and returns "" for an empty array.
        // `requires: ["skills"]` lets the subagent rebuilder drop this section
        // for read-only agents that have no `skill` tool — without it, the
        // listing would be noise (visible to the model but unreachable).
        const skillsPrompt = formatSkillsForSystemPrompt(this.resources.skills ?? []);
        if (skillsPrompt) contributors.push({ append: skillsPrompt, requires: ["skills"] });
        // The model identity snapshot is fixed at workspace construction — mid-session
        // `setSessionModel` switches the runtime model but does not rebuild the
        // prompt. Documented in `<model_identity>` so the model has a stable
        // self-reference for cost / context-window reasoning within the session.
        const modelIdentity = this.defaultModel
            ? `${this.defaultModel.provider}/${this.defaultModel.id}`
            : undefined;
        // Read .gitignore at construction time. Synchronous: only runs once
        // per workspace, file is bounded by the per-line truncation in
        // `projectContextForPrompt`. ENOENT returns ""; any other read
        // failure (permissions, symlink loop, transient fs) is logged and the
        // workspace still comes up — an unreadable .gitignore should never
        // block startup.
        // For IM/third-party channels we hide the absolute workspace path from
        // the block while keeping the denylist, so the remote platform does not
        // see the local filesystem location.
        let projectContext = "";
        try {
            projectContext = projectContextForPrompt({
                cwd: this.executionCwd,
                hideCwd: isIm,
            });
        } catch (e) {
            log.warn(
                `failed to read .gitignore for system prompt: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        // Resolve project-context instructions (CLAUDE.md / AGENTS.md / DESIGN.md)
        // once at construction. The context hook re-resolves lazily on every
        // LLM call (so a settings.write patch takes effect without restart),
        // and updateInstructionsConfig() recomputes this snapshot too — the
        // subagent system-prompt rebuild path is driven from this string.
        // Resolution is sync (readFileSync) and bounded by the small-file
        // assumption documented in instructions.ts.
        const instructionsConfig = options.instructionsConfig;
        this.parentInstructionsBlock = renderParentInstructionsBlock(
            this.executionCwd,
            instructionsConfig,
        );
        this.instructionsConfig = instructionsConfig;
        this.systemPrompt = buildSystemPrompt({
            tools: this.tools,
            modelIdentity,
            projectContext,
            contributors: contributors.length > 0 ? contributors : undefined,
            sessionKind: { role: "main", depth: 0 },
            hideWorkspacePath: isIm,
        });
        this.streamOptions = options.streamOptions ?? {};
        this.defaultThinkingLevel = options.defaultThinkingLevel;
        this.defaultUiLocale = options.defaultUiLocale;
        this.compaction = options.compaction;
        // MemoryStore.initialize is sync (LocalMemoryStore does sync I/O internally).
        // Disable by passing `memoryEnabled: false` — hooks downstream check for
        // the `NoOpMemoryStore` (returns "" for buildMemoryBlock), so the cost is
        // one extra hook invocation per context build that short-circuits.
        this.memoryStore =
            options.memoryEnabled !== false ? new LocalMemoryStore() : new NoOpMemoryStore();
        // Memory stays partitioned by session identity: two IM chats bound to the
        // same local workspace must not merge long-term memory.
        this.memoryStore.initialize(this.sessionCwd);

        // One store per workspace, shared by every session in it, so a restore
        // can reach snapshots an earlier session took. Files are written under
        // executionCwd, so snapshots track that tree. Off when fs tools are denied.
        const fsToolsEnabled = imPolicy
            ? imPolicy.tools.fsTools === "allow"
            : !options.disableFsTools;
        this.checkpointStore = fsToolsEnabled ? new CheckpointStore(this.executionCwd) : undefined;

        const agents = options.agents ?? [];
        const skills = this.resources.skills ?? [];

        // ── Assemble the three components ──
        // Order matters: SessionRegistry first (it owns the attached map and
        // AgentSpawner calls its attachChild). AgentSpawner is injected into
        // SessionRegistry's spawnSubagent / spawnSkillSubagent as arrow functions so
        // it may be assigned afterwards — lazy evaluation avoids a construction-time
        // mutual-reference deadlock.
        this.sessionRegistry = new SessionRegistry({
            cwd: this.sessionCwd,
            repo: this.repo,
            sessionsRoot: this.sessionsRoot,
            env: this.env,
            models: this.models,
            defaultModel: this.defaultModel,
            systemPrompt: this.systemPrompt,
            tools: this.tools,
            resources: this.resources,
            streamOptions: this.streamOptions,
            defaultThinkingLevel: this.defaultThinkingLevel,
            extensions: this.extensions,
            defaultUiLocale: this.defaultUiLocale,
            compaction: this.compaction,
            spawnSubagent: (args) => this.agentSpawner.spawnSubagent(args),
            resumeSubagent: (args) => this.agentSpawner.resumeSubagent(args),
            spawnSkillSubagent: (opts) => this.agentSpawner.spawnSkillSubagent(opts),
            availableAgentTypes: agents.map((a) => a.agentType),
            skills,
            memoryStore: this.memoryStore,
            isIm,
            checkpointStore: this.checkpointStore,
            toolRegistry: this.toolRegistry,
            toolsBuilder,
            // Thunk reads the current value of `instructionsConfig` — bound
            // to the workspace field, so `updateInstructionsConfig()` can
            // hot-reload without re-constructing the registry. `undefined`
            // here means "use defaults" (resolveInstructions handles it).
            getInstructionsConfig: () => this.instructionsConfig,
            // For IM workspaces only: resolve the route's channelId to its safe
            // channel identity. Filesystem workspaces yield undefined — the
            // im_channel hook injects nothing there.
            getImChannelContext: imChannelId
                ? () => options.resolveImChannel?.(imChannelId)
                : undefined,
        });

        this.agentSpawner = new AgentSpawner({
            cwd: this.sessionCwd,
            repo: this.repo,
            env: this.env,
            models: this.models,
            tools: this.tools,
            agents,
            sessionRegistry: this.sessionRegistry,
            systemPromptContributors: contributors.length > 0 ? contributors : undefined,
            defaultModel: this.defaultModel,
            projectContext,
            hideWorkspacePath: isIm,
            parentInstructionsBlock: this.parentInstructionsBlock,
        });

        this.modelRegistry = new ModelRegistry({
            models: this.models,
            sessionRegistry: this.sessionRegistry,
            providerKeyStore: options.providerKeyStore,
            customProviders: options.customProviders,
            registerProviders: false,
        });

        // ── Event forwarding: components → facade ──
        // SessionRegistry's five session.* events plus AgentSpawner's
        // subagent.spawned. ModelRegistry emits nothing (it reacts to key changes).
        // Each component removes its own listeners on dispose, so the facade does
        // not manage the forwarding subscriptions' lifetime.
        forwardEvents(this.sessionRegistry, this, [
            "session.event",
            "session.attached",
            "session.detached",
            "session.error",
            "session.deleted",
        ]);
        forwardEvents(this.agentSpawner, this, ["subagent.spawned"]);
    }

    // ─────────── session list / history (delegates to SessionRegistry) ───────────

    /** List all session metadata in this workspace (JsonlSessionRepo.list, cached). */
    async listSessions(): Promise<JsonlSessionMetadata[]> {
        return await this.sessionRegistry.listSessions();
    }

    invalidateListCache(): void {
        this.sessionRegistry.invalidateListCache();
    }

    /** Get an existing session instance by id. */
    async openSession(sessionId: SessionId): Promise<JsonlSessionMetadata> {
        return await this.sessionRegistry.openSession(sessionId);
    }

    /**
     * Append a new title to the session (pi-agent-core `session_info`, append-only).
     * Semantically a rename: reads take the last session_info. No attach required.
     */
    async renameSession(sessionId: SessionId, name: string): Promise<void> {
        await this.sessionRegistry.renameSession(sessionId, name);
    }

    /** Current title of a session (last session_info), or undefined. */
    async getSessionName(sessionId: SessionId): Promise<string | undefined> {
        return await this.sessionRegistry.getSessionName(sessionId);
    }

    /** Full chat tree history (from the session's leaf up to the root). */
    async getHistory(
        sessionId: SessionId,
    ): Promise<{ leafEntryId: string | null; entries: SessionTreeEntry[] }> {
        return await this.sessionRegistry.getHistory(sessionId);
    }

    // ─────────── attach / detach (delegates to SessionRegistry) ───────────

    async attach(sessionId: SessionId, opts: AttachOptions = {}): Promise<AttachedSession> {
        return await this.sessionRegistry.attach(sessionId, opts);
    }

    /**
     * Push the session's current task / plan snapshot to desktop.
     *
     * Covers "attached an old session / restarted desktop with no mutation tool
     * run yet": only mutation tools trigger a push, attach itself does not,
     * so without this the TaskPanel / PlanPanel would show "no tasks/plan"
     * until the next mutation.
     */
    publishCurrentTaskSnapshot(sessionId: SessionId): void {
        const attached = this.sessionRegistry.getAttached(sessionId);
        if (!attached) return;
        this.taskAdapter.publishTasksUpdated(this.sessionCwd, sessionId, attached.taskStore);
    }

    /** Push the session's current plan state snapshot to desktop. */
    publishCurrentPlanSnapshot(sessionId: SessionId): void {
        const attached = this.sessionRegistry.getAttached(sessionId);
        if (!attached) return;
        this.planAdapter.publishPlanState(this.sessionCwd, sessionId, {
            active: attached.planState.active,
            currentSlug: attached.planState.currentSlug,
        });
    }

    async detach(sessionId: SessionId): Promise<void> {
        await this.sessionRegistry.detach(sessionId);
        this.permissionBroker.cleanupSession(sessionId);
    }

    /** Delete a session: detach first (if attached) to release the harness, then remove the .jsonl. */
    async deleteSession(sessionId: SessionId): Promise<void> {
        await this.sessionRegistry.deleteSession(sessionId);
        this.permissionBroker.cleanupSession(sessionId);
    }

    getAttached(sessionId: SessionId): AttachedSession | undefined {
        return this.sessionRegistry.getAttached(sessionId);
    }

    /**
     * List restore points, newest first. Reads the store directly rather than
     * going through an attached session, so checkpoints from earlier sessions
     * remain listable after a restart.
     */
    async listCheckpoints(sessionId?: SessionId): Promise<CheckpointMeta[]> {
        if (!this.checkpointStore) return [];
        return await this.checkpointStore.list(sessionId);
    }

    /**
     * Roll the workspace back to a checkpoint. Snapshots the current state
     * first via the attached session's manager so the protection snapshot is
     * attributed to it. `sessionId` is required: an unattributed "detached"
     * label would pollute the workspace-scoped list and break the
     * sessionId-scoped listing contract.
     */
    async restoreCheckpoint(
        checkpointId: string,
        sessionId: SessionId,
    ): Promise<{ outcome: RestoreOutcome; protectionId?: string }> {
        if (!sessionId) {
            throw new Error("sessionId is required for restoreCheckpoint");
        }
        const store = this.checkpointStore;
        if (!store) throw new Error("checkpoints are disabled for this workspace");

        const attached = this.sessionRegistry.getAttached(sessionId);
        const manager = attached?.checkpoints ?? new CheckpointManager({ store, sessionId });
        const { outcome, protection } = await manager.restore(checkpointId);
        return { outcome, protectionId: protection?.id };
    }

    /**
     * Synchronously return a session's kind — server.emitPush stamps sessionKind
     * on every frame with it. Never-attached sessions (which should never push)
     * default to "main".
     */
    getSessionKind(sessionId: SessionId): "main" | "subagent" {
        return this.sessionRegistry.getSessionKind(sessionId);
    }

    // ─────────── model switching (delegates to ModelRegistry) ───────────

    /** List models currently available in this workspace (built-in catalog + registered providers). */
    listAvailableModels(provider?: string): ModelInfo[] {
        return this.modelRegistry.listAvailableModels(provider);
    }

    /** Availability view (configured + models) of built-in and custom providers, for the providers.list RPC. */
    listConfiguredProviders(): ProviderInfo[] {
        return this.modelRegistry.listConfiguredProviders();
    }

    /** Replace the custom provider set at runtime (pushed by server after settings.write). */
    setCustomProviders(next: readonly CustomProviderConfig[]): void {
        this.modelRegistry.setCustomProviders(next);
    }

    /**
     * Hot-reload the workspace default model after settings.write changes
     * `defaultModel` / `defaultProvider`. Resolves against the live catalog
     * (same rules as the constructor) and updates both this runtime and its
     * SessionRegistry so the NEXT session.create / attach uses it. Already
     * attached sessions keep their current model until switched explicitly.
     *
     * Without this, the workspace built before the user configured a provider
     * keeps its construction-time fallback (first catalog model, typically
     * anthropic/claude-*), and every fresh session fails with "Provider is
     * not configured" even though the user set a valid default in Settings.
     */
    setDefaultModel(defaultModel?: string, defaultProvider?: string): void {
        let resolved: Model<Api> | undefined;
        if (defaultModel) {
            resolved = defaultProvider
                ? this.models.getModel(defaultProvider, defaultModel)
                : findModelById(this.models, defaultModel);
            if (!resolved) {
                const label = defaultProvider
                    ? `${defaultProvider}/${defaultModel}`
                    : defaultModel;
                log.error(
                    `default model "${label}" not found in catalog — leaving previous default unchanged.`,
                );
                return;
            }
        } else {
            const all = this.models.getModels();
            resolved = all.length > 0 ? all[0] : undefined;
        }
        this.defaultModel = resolved;
        this.sessionRegistry.defaultModel = resolved;
    }

    /** Hot-reload the instructions config. */
    updateInstructionsConfig(next: InstructionsConfig | undefined): void {
        this.instructionsConfig = next;
        this.parentInstructionsBlock = renderParentInstructionsBlock(this.executionCwd, next);
    }

    /**
     * Invalidate the compaction cache of every attached session. Called by the
     * server after `settings.write` touches compaction fields so the next
     * `effectiveCompaction()` in every workspace reads the new value from disk.
     */
    invalidateCompactionCache(): void {
        this.sessionRegistry.invalidateAllCompactionCaches();
    }

    /** Switch a session to {provider, modelId}. */
    async setSessionModel(sessionId: SessionId, provider: string, modelId: string): Promise<void> {
        await this.modelRegistry.setSessionModel(sessionId, provider, modelId);
    }

    /** Switch the thinking level of an attached session at runtime. */
    async setSessionThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
        await this.modelRegistry.setSessionThinkingLevel(sessionId, level);
    }

    // ─────────── subagent (delegates to AgentSpawner) ───────────

    /** Look up a subagent definition by agentType. */
    findAgent(type: string): AgentDefinition | undefined {
        return this.agentSpawner.findAgent(type);
    }

    /**
     * Spawn a subagent via the Agent tool: validates agentType against the registry,
     * builds toolset from agent definition (whitelist + depth filter), then delegates
     * to executeSubagentSession.
     */
    async spawnSubagent(args: {
        parentSessionId: SessionId;
        parentToolCallId: string;
        agentType: string;
        prompt: string;
        signal?: AbortSignal;
    }): Promise<{ subSessionId?: SessionId; resultText: string; isError: boolean }> {
        return await this.agentSpawner.spawnSubagent(args);
    }

    /**
     * Run a skill as a sandboxed subagent session.
     *
     * Prepares the skill-specific prompt (interpolated body), toolset (allowedTools
     * whitelist + Skill removal), and optional model override, then delegates to
     * executeSubagentSession.
     */
    async runSkillSubagent(args: {
        parentSessionId?: SessionId;
        parentToolCallId: string;
        skillName: string;
        skillContent: string;
        args: string;
        allowedTools?: readonly string[];
        model?: string;
        signal?: AbortSignal;
    }): Promise<{ subSessionId?: string; resultText: string; isError: boolean }> {
        return await this.agentSpawner.runSkillSubagent(args);
    }

    async dispose(): Promise<void> {
        // Ordering:
        //  - permissionBroker.cleanupAll first: any pending command approvals are
        //    rejected so shell tools don't hang waiting for a disposed workspace.
        //  - sessionRegistry disposes last: it walks attached sessions calling
        //    harness.abort(), the real path that stops in-flight subagents
        //  - agentSpawner.removeAllListeners() first: drops the subagent.spawned
        //    forwarding subscription so no pushes bubble up after abort
        //  - modelRegistry needs no dispose: the catalog is permanent and it does
        //    not subscribe to ProviderKeyStore
        this.permissionBroker.cleanupAll();
        this.agentSpawner.removeAllListeners();
        await this.sessionRegistry.dispose();
        await this.toolRegistry.dispose?.();
        this.removeAllListeners();
    }
}

/**
 * Union of workspace-level events forwarded by the facade — a typo in an event
 * name is a compile error. Sources: SessionRegistry (session.*) and AgentSpawner
 * (subagent.spawned). `forwardEvents` constrains its `events` parameter to this
 * union, so add the literal here first when a component gains a new event.
 */
export type WorkspaceEvent =
    | "session.event"
    | "session.error"
    | "session.attached"
    | "session.detached"
    | "session.deleted"
    | "subagent.spawned";

/**
 * Resolve the workspace's instructions against `config` and render them into
 * a single string. Returns "" when disabled or no files match. Logs per-file
 * errors via the workspace logger so both the constructor and
 * `updateInstructionsConfig` share the same render path.
 */
function renderParentInstructionsBlock(
    cwd: string,
    config: InstructionsConfig | undefined,
): string {
    const resolution = resolveInstructions({ cwd, config });
    for (const { name, message } of resolution.errors) {
        log.warn(`failed to read ${name}: ${message}`);
    }
    if (resolution.blocks.length === 0) return "";
    return resolution.blocks.map(renderInstructionBlock).join("\n");
}

/**
 * Forward the given events 1:1 from source to target. Each component removes its
 * own listeners on dispose, so the facade does not manage these subscriptions.
 */
function forwardEvents(
    source: EventEmitter,
    target: EventEmitter,
    events: readonly WorkspaceEvent[],
): void {
    for (const evt of events) {
        source.on(evt, (...args: unknown[]) => target.emit(evt, ...args));
    }
}

/**
 * Builds memory-tool deps. When `dispatchRpc` is undefined, returns undefined
 * (memory tool is not wired). Otherwise wraps `dispatchRpc` directly rather
 * than going through `createTypedRpc` — the sidecar does not depend on
 * `@taco-ai/shared`, and the `memory.upsert` handler already validates via
 * typebox, so an extra typed wrapper would add no value.
 *
 * id uses `self-${random}` so log lines can spot in-process tool calls;
 * the handler ignores it except to echo back into `RpcResponse.id`.
 */
function makeMemoryDeps(
    dispatchRpc: ((req: RpcRequest) => Promise<RpcResponse>) | undefined,
    workspace: WorkspaceId,
): MemoryToolDeps | undefined {
    if (!dispatchRpc) return undefined;
    return {
        workspace,
        call: async <P, R>(method: string, _ws: WorkspaceId, params: P): Promise<R> => {
            const req: RpcRequest = {
                id: `self-${crypto.randomUUID().toLowerCase()}`,
                method,
                params,
            };
            const resp = await dispatchRpc(req);
            if (resp.ok) return resp.result as R;
            throw new Error(`${resp.error.code}: ${resp.error.message}`);
        },
    };
}
