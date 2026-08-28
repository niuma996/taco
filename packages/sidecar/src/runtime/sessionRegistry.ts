/**
 * SessionRegistry — owns session lifecycle and state within a workspace.
 *
 * Responsibilities: holds repo / attached map / sessionKinds / metadata cache;
 * session CRUD: list / open / rename / getHistory / delete;
 * attach / detach / attachChild (used by AgentSpawner);
 * forwards AttachedSession events as workspace-level `session.*` events.
 *
 * Not in this class: subagent spawn (AgentSpawner), model switching (ModelRegistry).
 */

import { EventEmitter } from "node:events";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    JsonlSessionMetadata,
    JsonlSessionRepo,
    PromptTemplate,
    SessionTreeEntry,
    ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type {
    InstructionsConfig,
    SessionId,
    SupportedLocale,
    WorkspaceId,
} from "@taco-ai/protocol";
import type { SubagentContextMode, SubagentSpawnContext } from "../agents/types.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import type { ResolvedCompaction } from "../config/config.ts";
import type { WorkspaceExtensionSet } from "../extensions/index.ts";
import type { MemoryStore } from "../memory/index.ts";
import type { SkillReinjectorHandle } from "../skills/skillReinjector.ts";
import type { SpawnSkillSubagentOptions } from "../skills/skillTool.ts";
import { createSkillTool } from "../skills/skillTool.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import type { ImChannelContext } from "../tags/index.ts";
import { type AgentTypeDescriptor, createAgentTool } from "../tools/agent.ts";
import { createAgentContinueTool } from "../tools/agentContinue.ts";
import type { TacoToolContext } from "../tools/context.ts";
import type { TacoTool } from "../tools/index.ts";
import { AttachedSession } from "./attachedSession.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import { buildSessionTaskState, type SessionTaskState } from "./sessionTaskState.ts";

/** `attach()` per-call override parameters — same shape as WorkspaceRuntime.AttachOptions */
export interface AttachOptions {
    thinkingLevel?: ThinkingLevel;
    /** Optional model override (subagent path lets frontmatter.model take effect) */
    model?: Model<Api>;
}

export interface SessionRegistryOptions {
    readonly cwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
    /** Root dir the repo's sessions live under — task state persists alongside it. */
    readonly sessionsRoot: string;
    readonly env: NodeExecutionEnv;
    readonly models: Models;
    readonly defaultModel?: Model<Api>;
    readonly systemPrompt: string;
    readonly tools: TacoTool[];
    readonly resources: AgentHarnessResources<TacoSkill, PromptTemplate>;
    readonly streamOptions: AgentHarnessStreamOptions;
    readonly defaultThinkingLevel?: ThinkingLevel;
    readonly extensionRegistry?: never;
    /**
     * Per-workspace extension contributions, produced by `activateExtensions`.
     * `undefined` when no extensions are configured.
     */
    readonly extensions?: Readonly<WorkspaceExtensionSet>;
    readonly defaultUiLocale?: SupportedLocale;
    readonly compaction?: ResolvedCompaction;
    /**
     * Workspace-shared checkpoint store. Shared rather than per-session so a
     * restore can reach snapshots taken by an earlier session in the same
     * workspace; attribution is preserved by `CheckpointMeta.sessionId`.
     */
    readonly checkpointStore?: CheckpointStore;
    /**
     * Spawn callback injected by the facade — lets attach()'s TacoTool spawn
     * subagents without SessionRegistry importing AgentSpawner directly.
     * Arrow-function deferred evaluation allows AgentSpawner to be assigned
     * after SessionRegistry.
     */
    readonly spawnSubagent: (args: {
        parentSessionId: SessionId;
        parentToolCallId: string;
        agentType: string;
        prompt: string;
        context?: SubagentContextMode;
        signal?: AbortSignal;
    }) => Promise<{ subSessionId?: SessionId; resultText: string; isError: boolean }>;
    /**
     * Resume callback for the `agentContinue` tool. Same deferred-evaluation
     * pattern as `spawnSubagent`. The facade supplies an arrow that calls
     * AgentSpawner.resumeSubagent — moved to a separate option so the spawn
     * surface stays narrow for callers (e.g. tests) that want only fresh
     * subagents.
     */
    readonly resumeSubagent: (args: {
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        prompt: string;
        signal?: AbortSignal;
    }) => Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }>;
    /** Skill subagent spawn callback (same deferred AgentSpawner pattern). */
    readonly spawnSkillSubagent: (
        opts: SpawnSkillSubagentOptions,
    ) => Promise<{ subSessionId?: string; resultText: string; isError: boolean }>;
    /**
     * Available agent types — which agentTypes the agent tool can invoke, plus
     * the frontmatter the model needs to choose between them. Descriptors, not
     * bare names: the tool description is the only place the model sees agent
     * capabilities, so a name alone makes user-defined agents unpickable.
     */
    readonly availableAgentTypes: readonly AgentTypeDescriptor[];
    /** Available skills — injected into SkillTool. */
    readonly skills: readonly TacoSkill[];
    /**
     * "Where does a new skill go" + taco-private frontmatter contract, appended
     * to the skill tool's description. Rendered once by WorkspaceRuntime from
     * `executionCwd`; SessionRegistry only forwards it. Empty string is a valid
     * value (workspace construction never actually produces one, but no caller
     * should crash if it does) — `createSkillTool` treats falsy as "omit".
     */
    readonly skillAuthoringGuidance?: string;
    /** User-level memory store — drives extraction + context injection. */
    readonly memoryStore?: MemoryStore;
    /** True for IM workspaces; disables memory extraction there. */
    readonly isIm?: boolean;
    /**
     * Per-session tool factory: takes a sessionId and the session's hydrated
     * taskState, returns tools with sessionId injected. WorkspaceRuntime uses
     * this to attach sessionId-scoped task/plan tools on attach. When absent,
     * SessionRegistry.attach falls back to this.tools (workspace-static set).
     */
    readonly toolsBuilder?: (sessionId: SessionId, taskState: SessionTaskState) => TacoTool[];
    /** Dynamic-tool candidate directory; forwarded to AttachedSession.create to wire AddTools and restore. */
    readonly toolRegistry?: DeferredToolRegistry;
    /**
     * Lazy accessor for the current `InstructionsConfig`. The instructions
     * context hook reads this on every LLM call, so a `settings.write` patch
     * takes effect without re-attaching the session. WorkspaceRuntime wires
     * the thunk from the latest `taco.json: instructions` after each patch.
     */
    readonly getInstructionsConfig?: () => InstructionsConfig | undefined;
    /**
     * Lazy accessor for the current IM channel identity (platform type +
     * configured instance id). `undefined` for non-IM workspaces. Forwarded
     * to every AttachedSession so the im_channel context hook can read it on
     * each LLM call.
     */
    readonly getImChannelContext?: () => ImChannelContext | undefined;
    /**
     * Per-turn tool context provider. Threaded straight through to every
     * AttachedSession's harness — the harness calls it once per turn to
     * resolve the `TacoToolContext` snapshot for that turn's tool calls.
     * WorkspaceRuntime wires this from `sessionCwd` + `dispatchRpc` +
     * `imRouting`; tests can pass an inline closure.
     */
    readonly getToolContext: () => TacoToolContext;
}

export class SessionRegistry extends EventEmitter {
    readonly sessionCwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
    readonly sessionsRoot: string;
    readonly env: NodeExecutionEnv;
    readonly models: Models;
    // Mutable: settings.write can change the default model at runtime (e.g. the
    // user configures a provider after the sidecar started). New attaches read
    // the current value; already-attached sessions keep their own model until
    // switched. See WorkspaceRuntime.setDefaultModel.
    defaultModel?: Model<Api>;
    readonly systemPrompt: string;
    readonly tools: TacoTool[];
    /** NOT readonly: `updateSkills()` replaces this so every attach after a
     *  hot reload gives its new harness the same fresh skill resources that
     *  WorkspaceRuntime exposes through `workspace.resources`. */
    resources: AgentHarnessResources<TacoSkill, PromptTemplate>;
    readonly streamOptions: AgentHarnessStreamOptions;
    readonly defaultThinkingLevel?: ThinkingLevel;
    readonly extensionRegistry?: never;
    /**
     * Per-workspace extension contributions, produced by `activateExtensions`.
     * `undefined` when no extensions are configured.
     */
    readonly extensions?: Readonly<WorkspaceExtensionSet>;
    readonly defaultUiLocale?: SupportedLocale;
    readonly compaction?: ResolvedCompaction;
    readonly checkpointStore?: CheckpointStore;
    readonly toolRegistry?: DeferredToolRegistry;
    /** Lazy accessor for the current `InstructionsConfig` (see options below). */
    readonly getInstructionsConfig?: () => InstructionsConfig | undefined;
    /** Lazy accessor for the current IM channel identity (see options below). */
    readonly getImChannelContext?: () => ImChannelContext | undefined;
    /** Per-turn tool context provider (see options below). */
    readonly getToolContext: () => TacoToolContext;

    /** cwd → workspace metadata cache, based on list for this cwd */
    private _metadataCache: JsonlSessionMetadata[] | null = null;

    /**
     * sessionId → user-defined title (last session_info event).
     * Same lifecycle as _metadataCache: create/delete go through
     * invalidateListCache; rename updates a single entry in place via
     * renameSession (avoids N repo.open calls on next list).
     */
    private readonly _nameCache = new Map<SessionId, string | undefined>();

    /** Currently attached session map. */
    private readonly attached = new Map<SessionId, AttachedSession>();

    /**
     * sessionId → "main" | "subagent".
     * Written by attachWithTools; read synchronously by server.emitPush to
     * tag every frame with sessionKind. Must be a sync-readable Map — cannot
     * await openSession.
     */
    private readonly sessionKinds = new Map<SessionId, "main" | "subagent">();

    private readonly spawnSubagent: SessionRegistryOptions["spawnSubagent"];
    private readonly resumeSubagent: SessionRegistryOptions["resumeSubagent"];
    private readonly spawnSkillSubagent: SessionRegistryOptions["spawnSkillSubagent"];
    private readonly availableAgentTypes: readonly AgentTypeDescriptor[];
    /**
     * Per-session tool factory: takes a sessionId and returns tools with that
     * sessionId injected. When WorkspaceRuntime owns task/plan tools and
     * wants push events routed through the sidecar global stream, this builder
     * constructs per-sessionId copies (sharing task store / plan state).
     * Falls back to this.tools (workspace-static set) when absent.
     */
    private readonly toolsBuilder:
        | ((sessionId: SessionId, taskState: SessionTaskState) => TacoTool[])
        | undefined;
    /** NOT readonly: `updateSkills()` swaps this in on hot reload. */
    private skills: readonly TacoSkill[];
    private readonly skillAuthoringGuidance?: string;
    private readonly memoryStore?: MemoryStore;
    private readonly isIm?: boolean;

    constructor(options: SessionRegistryOptions) {
        super();
        this.sessionCwd = options.cwd;
        this.repo = options.repo;
        this.sessionsRoot = options.sessionsRoot;
        this.env = options.env;
        this.models = options.models;
        this.defaultModel = options.defaultModel;
        this.systemPrompt = options.systemPrompt;
        this.tools = options.tools;
        this.resources = options.resources;
        this.streamOptions = options.streamOptions;
        this.defaultThinkingLevel = options.defaultThinkingLevel;
        this.extensions = options.extensions;
        this.defaultUiLocale = options.defaultUiLocale;
        this.compaction = options.compaction;
        this.checkpointStore = options.checkpointStore;
        this.toolRegistry = options.toolRegistry;
        this.getInstructionsConfig = options.getInstructionsConfig;
        this.getImChannelContext = options.getImChannelContext;
        this.getToolContext = options.getToolContext;
        this.spawnSubagent = options.spawnSubagent;
        this.resumeSubagent = options.resumeSubagent;
        this.spawnSkillSubagent = options.spawnSkillSubagent;
        this.availableAgentTypes = options.availableAgentTypes;
        this.skills = options.skills;
        this.skillAuthoringGuidance = options.skillAuthoringGuidance;
        this.memoryStore = options.memoryStore;
        this.isIm = options.isIm;
        this.toolsBuilder = options.toolsBuilder;
    }

    getListingTools(): TacoTool[] {
        const listing: TacoTool[] = [];
        const listingCtx: SubagentSpawnContext = {
            spawn: () => Promise.reject(new Error("tools.list stub: not executable")),
            continue: () => Promise.reject(new Error("tools.list stub: not executable")),
        };
        listing.push(createAgentTool(listingCtx, [...this.availableAgentTypes]));
        listing.push(createAgentContinueTool(listingCtx));
        listing.push(
            createSkillTool(() => this.skills, {
                parentSessionId: "",
                getReinjector: () => undefined,
                skillAuthoringGuidance: this.skillAuthoringGuidance,
            }),
        );
        return listing;
    }

    // ─────────── session list / history (pull API) ───────────

    /** List all session metadata for the workspace (via JsonlSessionRepo.list, cached). */
    async listSessions(): Promise<JsonlSessionMetadata[]> {
        if (!this._metadataCache) {
            try {
                const list = await this.repo.list({ cwd: this.sessionCwd });
                // Empty result is not cached: repo.list silently skips unparseable .jsonl files (invalid_session),
                // and sidecar restart / fs-not-ready transient jitter may return an empty batch.
                // If an empty array were cached, _metadataCache would become truthy and never refetch,
                // locking the session list at empty even though the files are still there.
                // Empty → treat as "not ready", refetch on next call; only non-empty results are cached.
                if (list.length > 0) {
                    this._metadataCache = list;
                }
                return list;
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                throw new Error(`failed to list sessions: ${errMsg}`);
            }
        }
        return this._metadataCache;
    }

    invalidateListCache(): void {
        this._metadataCache = null;
        this._nameCache.clear();
    }

    /** Get an existing session instance by id. */
    async openSession(sessionId: SessionId): Promise<JsonlSessionMetadata> {
        const list = await this.listSessions();
        const meta = list.find((m) => m.id === sessionId || m.id.startsWith(sessionId));
        if (!meta) {
            throw new Error(`session not found: ${sessionId}`);
        }
        return meta;
    }

    /**
     * Resolve the root display context for a session — the topmost ancestor
     * session and the toolCallId of the root's direct agent tool call.
     *
     * Main session (no parentSessionId): returns itself + undefined tcid.
     * Subagent chain S2 → S1 → R: returns { R, R_A } where R_A is the
     * toolCallId R used to spawn its direct child. Lookup failure falls back
     * to the input session + current rootToolCallId; never throws.
     */
    async resolveDisplayContext(
        sessionId: SessionId,
    ): Promise<{ displaySessionId: SessionId; displayToolCallId: string | undefined }> {
        let current: SessionId = sessionId;
        let rootToolCallId: string | undefined;
        const seen = new Set<string>();
        for (;;) {
            if (seen.has(current)) break;
            seen.add(current);
            let meta: JsonlSessionMetadata;
            try {
                meta = await this.openSession(current);
            } catch {
                break;
            }
            const md = meta.metadata as Record<string, unknown> | undefined;
            const parent =
                typeof md?.parentSessionId === "string"
                    ? (md.parentSessionId as SessionId)
                    : undefined;
            if (!parent) break;
            const tcid = typeof md?.parentToolCallId === "string" ? md.parentToolCallId : undefined;
            if (tcid) rootToolCallId = tcid;
            current = parent;
        }
        return { displaySessionId: current, displayToolCallId: rootToolCallId };
    }

    /**
     * Append a new title to a session (pi-agent-core's session_info event,
     * append-only). Semantically a "rename": readers take the last
     * session_info. Does not require attach. Updates _nameCache in place
     * after write, so callers don't need invalidateListCache (metadata unchanged).
     */
    async renameSession(sessionId: SessionId, name: string): Promise<void> {
        const meta = await this.openSession(sessionId);
        const session = await this.repo.open(meta);
        await session.appendSessionName(name);
        this._nameCache.set(sessionId, name);
    }

    /** Read the current title of a session (last session_info), or undefined. Cache-hit avoids disk I/O. */
    async getSessionName(sessionId: SessionId): Promise<string | undefined> {
        if (this._nameCache.has(sessionId)) {
            return this._nameCache.get(sessionId);
        }
        const meta = await this.openSession(sessionId);
        const session = await this.repo.open(meta);
        const name = await session.getSessionName();
        this._nameCache.set(sessionId, name);
        return name;
    }

    /** Get the full chat tree history (from session leaf up to root). */
    async getHistory(
        sessionId: SessionId,
    ): Promise<{ leafEntryId: string | null; entries: SessionTreeEntry[] }> {
        const meta = await this.openSession(sessionId);
        const session = await this.repo.open(meta);
        const leafId = await session.getLeafId();
        const entries = await session.getEntries();
        return { leafEntryId: leafId, entries };
    }

    // ─────────── attach / detach (required before session use) ───────────

    async attach(sessionId: SessionId, opts: AttachOptions = {}): Promise<AttachedSession> {
        // Return existing — do not overwrite a session's thinking level
        // (stable state wins; use `setSessionThinkingLevel()` to switch).
        const existing = this.attached.get(sessionId);
        if (existing) return existing;

        // Per-session task/plan state: built and hydrated from disk on attach
        // (each session independent). Must precede tool construction —
        // toolsBuilder closure reads taskState.taskStore/planState/tasksDir.
        const taskState = await buildSessionTaskState(sessionId, this.sessionsRoot);
        // Per-session tools built from sessionId + taskState (task store
        // independent; adapter + sessionId injected via factory closure —
        // task push routes through sidecar global push stream).
        const baseTools = this.toolsForSession(sessionId, taskState);
        // Per-session standard tools + agent tool (spawn context bound to this session).
        const spawnContext: SubagentSpawnContext = {
            spawn: (args) =>
                this.spawnSubagent({
                    parentSessionId: sessionId,
                    parentToolCallId: args.parentToolCallId,
                    agentType: args.agentType,
                    prompt: args.prompt,
                    context: args.context,
                    signal: args.signal,
                }),
            continue: (args) =>
                this.resumeSubagent({
                    parentSessionId: sessionId,
                    parentToolCallId: args.parentToolCallId,
                    subSessionId: args.subSessionId,
                    prompt: args.prompt,
                    signal: args.signal,
                }),
        };
        // Mutable cell captured by SkillTool's getReinjector thunk — populated
        // after attachChild wires harness hooks and exposes skillReinjector.
        const reinjectorCell = {
            current: undefined as SkillReinjectorHandle | undefined,
        };
        const sessionTools = [
            ...baseTools,
            createAgentTool(spawnContext, [...this.availableAgentTypes]),
            createAgentContinueTool(spawnContext),
            createSkillTool(() => this.skills, {
                parentSessionId: sessionId,
                getReinjector: () => reinjectorCell.current,
                spawnSkillSubagent: (opts) => this.spawnSkillSubagent(opts),
                skillAuthoringGuidance: this.skillAuthoringGuidance,
            }),
        ];
        const attached = await this.attachChild(sessionId, opts, sessionTools, taskState);
        reinjectorCell.current = attached.skillReinjector;
        return attached;
    }

    /**
     * Build the workspace tool set for a session (task + plan tools) from
     * sessionId + taskState. taskState is hydrated by attach() before this
     * call; each attach injects sessionId + an independent task store / plan
     * state into the new session.
     */
    private toolsForSession(sessionId: SessionId, taskState: SessionTaskState): TacoTool[] {
        if (this.toolsBuilder) {
            return this.toolsBuilder(sessionId, taskState);
        }
        return this.tools;
    }

    /**
     * Build child-session tools plus the taskState they were built from.
     * Returns both so the caller can hand the same taskState to attachChild —
     * otherwise the tools' closures and attached.taskStore would hold two
     * independent TaskStore instances and diverge on task mutation.
     */
    async toolsForChildSession(sessionId: SessionId): Promise<{
        tools: TacoTool[];
        taskState: SessionTaskState;
    }> {
        const taskState = await buildSessionTaskState(sessionId, this.sessionsRoot);
        return { tools: this.toolsForSession(sessionId, taskState), taskState };
    }

    /**
     * attach() underlying impl: builds an AttachedSession from caller-supplied
     * tools and does event/error forwarding + attached-map registration + push
     * events. Used by both attach() (mounts main-session tools incl. agent)
     * and AgentSpawner.spawnSubagent() (mounts depth-filtered subagent tools
     * excluding agent), so child-session events flow back via `session.event`.
     */
    async attachChild(
        sessionId: SessionId,
        opts: AttachOptions,
        tools: TacoTool[],
        taskState?: SessionTaskState,
        systemPrompt?: string,
    ): Promise<AttachedSession> {
        const existing = this.attached.get(sessionId);
        if (existing) return existing;

        // attach() builds and passes taskState; AgentSpawner subagent path
        // doesn't, so re-build here (subagent sessions also have independent
        // task/plan state).
        const resolvedTaskState =
            taskState ?? (await buildSessionTaskState(sessionId, this.sessionsRoot));

        const meta = await this.openSession(sessionId);
        const md = meta.metadata as Record<string, unknown> | undefined;
        this.sessionKinds.set(sessionId, md?.kind === "subagent" ? "subagent" : "main");
        const session = await this.repo.open(meta);
        const attached = await AttachedSession.create({
            session,
            models: this.models,
            env: this.env,
            model: opts.model ?? this.defaultModel,
            systemPrompt: systemPrompt ?? this.systemPrompt,
            tools,
            resources: this.resources,
            streamOptions: this.streamOptions,
            thinkingLevel: opts.thinkingLevel ?? this.defaultThinkingLevel,
            compaction: this.compaction,
            extensionContextHooks: this.extensions?.contextHooks(),
            extensionToolCallHooks: this.extensions?.toolCallHooks(),
            extensionToolResultHooks: this.extensions?.toolResultHooks(),
            defaultUiLocale: this.defaultUiLocale,
            skills: this.skills,
            memoryStore: this.memoryStore,
            isIm: this.isIm,
            taskStore: resolvedTaskState.taskStore,
            planState: resolvedTaskState.planState,
            tasksDir: resolvedTaskState.tasksDir,
            checkpointStore: this.checkpointStore,
            toolRegistry: this.toolRegistry,
            getInstructionsConfig: this.getInstructionsConfig,
            getImChannelContext: this.getImChannelContext,
            getToolContext: this.getToolContext,
            sessionCwd: this.sessionCwd,
        });

        this.attached.set(sessionId, attached);

        // Forward harness events to workspace-level events
        attached.on("event", (e) => this.emit("session.event", { sessionId, event: e }));
        attached.on("error", (e) => this.emit("session.error", { sessionId, error: e }));

        // Emit a one-shot attached push event
        this.emit("session.attached", { sessionId });

        return attached;
    }

    async detach(sessionId: SessionId): Promise<void> {
        const attached = this.attached.get(sessionId);
        if (!attached) return;
        await attached.dispose();
        this.attached.delete(sessionId);
        this.emit("session.detached", { sessionId });
    }

    /** Delete a session: detach first (if attached) to release the harness, then delete the underlying .jsonl. */
    async deleteSession(sessionId: SessionId): Promise<void> {
        await this.detach(sessionId);
        const meta = await this.openSession(sessionId);
        await this.repo.delete(meta);
        this.sessionKinds.delete(sessionId);
        this.invalidateListCache();
        this.emit("session.deleted", { sessionId });
    }

    getAttached(sessionId: SessionId): AttachedSession | undefined {
        return this.attached.get(sessionId);
    }

    /**
     * Iterate currently-attached sessions and invalidate each compaction cache.
     * Called by the workspace → server chain after `settings.write` updates the
     * compaction field, so changes apply at ns scale without waiting for TTL.
     */
    invalidateAllCompactionCaches(): void {
        for (const session of this.attached.values()) {
            session.invalidateCompactionCache();
        }
    }

    /**
     * Swap in a freshly-loaded skill list. Called by WorkspaceRuntime on
     * skill hot reload. Already-built `skill` tools pick this up on their
     * next `execute()` — `createSkillTool` closes over `() => this.skills`,
     * not a snapshot array, so no already-attached session needs its tools
     * rebuilt for skill *invocation* to see the new list. New attaches also
     * receive an updated `resources` object, so their AgentHarness uses the
     * same fresh skill list as `workspace.resources`. (Skill *discovery*
     * — the `<available_skills>` system-prompt section — is a separate,
     * baked-at-attach string this method does not touch; see
     * WorkspaceRuntime.reloadSkillsNow.)
     */
    updateSkills(skills: readonly TacoSkill[]): void {
        this.skills = skills;
        this.resources = { ...this.resources, skills: [...skills] };
    }

    /**
     * Synchronously return a session's kind — server.emitPush uses this to
     * tag every frame with sessionKind. Sessions that have never been attached
     * (no push should occur) default to "main".
     */
    getSessionKind(sessionId: SessionId): "main" | "subagent" {
        return this.sessionKinds.get(sessionId) ?? "main";
    }

    async dispose(): Promise<void> {
        for (const sessionId of [...this.attached.keys()]) {
            await this.detach(sessionId);
        }
        this.removeAllListeners();
    }
}
