/**
 * SessionRegistry — owns session lifecycle and state within a workspace.
 *
 * Responsibilities: holds repo / attached map / session facts cache;
 * session CRUD: list / open / rename / getHistory / delete;
 * attach / detach / attachChild (used by AgentSpawner);
 * forwards AttachedSession events as workspace-level `session.*` events.
 *
 * Not in this class: subagent spawn (AgentSpawner), model switching (ModelRegistry).
 */

import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import * as readline from "node:readline";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    Entry,
    JsonlSessionMetadata,
    JsonlSessionRepo,
    PromptTemplate,
    Session,
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
import { harnessContext } from "../lib/harnessContext.ts";
import { createLogger } from "../lib/logger.ts";
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
import { findBranchEntries, findBranchTipId } from "./sessionBranch.ts";
import { readSessionFacts, type SessionFacts } from "./sessionFacts.ts";
import { buildSessionTaskState, type SessionTaskState } from "./sessionTaskState.ts";

const log = createLogger("sidecar.sessionRegistry");

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

export type SessionPrefixResolution =
    | { kind: "found"; meta: JsonlSessionMetadata }
    | { kind: "not_found" }
    | { kind: "ambiguous"; matches: JsonlSessionMetadata[] };

/**
 * Resolve a session id or id prefix against a metadata list. Shared by
 * `SessionRegistry.openSession` and the `session.snapshot.get` handler, which
 * both accept "exact id, or the unique session whose id starts with this
 * prefix". Prefix acceptance dates to the initial commit; no in-tree caller
 * relies on it (the desktop truncates ids for display only and always sends
 * the full id back), so it is kept for out-of-tree and hand-issued RPCs
 * rather than for a known contract.
 *
 * An exact match always wins over a same-prefix collision — a naive
 * `list.find(m => m.id === id || m.id.startsWith(id))` returns whichever
 * candidate appears first, so an exact match can be shadowed by an unrelated
 * session whose id happens to start with it. Two or more *prefix* matches
 * (with no exact match) are reported as ambiguous rather than silently
 * picking one: uuidv7 puts the millisecond timestamp in the leading hex
 * digits, so sessions created in the same window share a short prefix and
 * "first match wins" would routinely open the wrong session. The caller
 * decides whether ambiguity is a hard error or a lenient fallback.
 */
export function resolveSessionByPrefix(
    list: readonly JsonlSessionMetadata[],
    sessionId: SessionId,
): SessionPrefixResolution {
    const exact = list.find((m) => m.id === sessionId);
    if (exact) return { kind: "found", meta: exact };
    const matches = list.filter((m) => m.id.startsWith(sessionId));
    if (matches.length === 0) return { kind: "not_found" };
    if (matches.length > 1) return { kind: "ambiguous", matches };
    return { kind: "found", meta: matches[0] };
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
     * sessionId → user-defined title (last name value written).
     * Same lifecycle as _metadataCache: create/delete go through
     * invalidateListCache; rename updates a single entry in place via
     * renameSession (avoids N repo.open calls on next list).
     */
    private readonly _nameCache = new Map<SessionId, string | undefined>();

    /**
     * sessionId → last facts record written. Populated together with the
     * name cache by the single-pass JSONL scan, so `session.list` pays one
     * stream scan per session rather than one for the title and another for
     * the facts.
     */
    private readonly _factsCache = new Map<SessionId, SessionFacts>();

    /** Currently attached session map. */
    private readonly attached = new Map<SessionId, AttachedSession>();

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
                const list = await this.repo.list({ cwd: this.sessionCwd }, harnessContext);
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
        this._factsCache.clear();
    }

    /** Get an existing session instance by id. */
    async openSession(sessionId: SessionId): Promise<JsonlSessionMetadata> {
        const list = await this.listSessions();
        const resolution = resolveSessionByPrefix(list, sessionId);
        if (resolution.kind === "not_found") {
            throw new Error(`session not found: ${sessionId}`);
        }
        if (resolution.kind === "ambiguous") {
            throw new Error(`session id prefix is ambiguous: ${sessionId}`);
        }
        return resolution.meta;
    }

    /**
     * Run a read against a session without leaking pi's open-session slot.
     *
     * `JsonlSessionRepo.open()` registers the session in an internal
     * `openSessions` map and throws "Session is already open" on a second open
     * of the same id. An attached session already holds that slot for its whole
     * lifetime, so a one-shot reader must reuse the attached handle when there
     * is one and close its own handle when there isn't — otherwise the first
     * read permanently locks the id and the next `attach()` fails.
     */
    async withSession<T>(sessionId: SessionId, read: (session: Session) => Promise<T>): Promise<T> {
        const attached = this.attached.get(sessionId);
        if (attached) return read(attached.session);
        const meta = await this.openSession(sessionId);
        const session = await this.repo.open(meta, harnessContext);
        try {
            return await read(session);
        } finally {
            await session.close(harnessContext);
        }
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
            // `parentSessionId` is standard 0.85 metadata; `parentToolCallId`
            // is a taco fact, so it comes from the values store.
            const facts = await this.withSession(current, (session) => readSessionFacts(session));
            const parent = (meta.parentSessionId ?? facts.parentSessionId) as SessionId | undefined;
            if (!parent) break;
            if (facts.parentToolCallId) rootToolCallId = facts.parentToolCallId;
            current = parent;
        }
        return { displaySessionId: current, displayToolCallId: rootToolCallId };
    }

    /**
     * Append a new title to a session (pi-agent-core name value,
     * append-only). Semantically a "rename": readers take the last
     * name value. Does not require attach. Updates _nameCache in place
     * after write, so callers don't need invalidateListCache (metadata unchanged).
     */
    async renameSession(sessionId: SessionId, name: string): Promise<void> {
        await this.withSession(sessionId, (session) => session.setName(name, harnessContext));
        this._nameCache.set(sessionId, name);
    }

    /** Read the current title of a session (last name value), or undefined. Cache-hit avoids disk I/O. */
    async getSessionName(sessionId: SessionId): Promise<string | undefined> {
        if (this._nameCache.has(sessionId)) {
            return this._nameCache.get(sessionId);
        }
        const meta = await this.openSession(sessionId);
        const { name, facts } = await readSessionMetadataFromDisk(meta.path);
        this._nameCache.set(sessionId, name);
        this._factsCache.set(sessionId, facts);
        return name;
    }

    /**
     * Read the sidecar's durable facts for a session (kind / agentType / depth /
     * parent linkage).
     *
     * pi 0.85 fixed the session metadata shape, so these live in the value
     * store on disk and are read via the same JSONL stream as the session
     * title. Both populate a per-session cache so a `session.list` that needs
     * both pays one scan per session rather than two. Falls through to a full
     * `repo.open()` only when the on-disk cache misses *and* the path-based
     * scan would not see a name line (i.e. an uninitialised session).
     */
    async getSessionFacts(sessionId: SessionId): Promise<SessionFacts> {
        if (this._factsCache.has(sessionId)) {
            return this._factsCache.get(sessionId) ?? {};
        }
        const meta = await this.openSession(sessionId);
        const { name, facts } = await readSessionMetadataFromDisk(meta.path);
        this._nameCache.set(sessionId, name);
        this._factsCache.set(sessionId, facts);
        return facts;
    }

    /** Get the full chat tree history (from session leaf up to root). */
    async getHistory(
        sessionId: SessionId,
    ): Promise<{ leafEntryId: string | null; entries: Entry[] }> {
        return this.withSession(sessionId, async (session) => {
            // Branch walk, not a whole-log scan: history is the conversation as
            // it currently stands, so entries on abandoned branches stay out.
            const [leafId, entries] = await Promise.all([
                findBranchTipId(session),
                findBranchEntries(session),
            ]);
            return { leafEntryId: leafId, entries };
        });
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
        const session = await this.repo.open(meta, harnessContext);
        const facts = await readSessionFacts(session);
        const sessionKind: "main" | "subagent" = facts.kind === "subagent" ? "subagent" : "main";
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
            sessionKind,
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
        await this.repo.delete(meta, harnessContext);
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
     * Synchronously classify a session for server.emitPush's frame stamping.
     * Reads the attached map (populated by attachChild from `facts.kind`), so
     * it is only accurate while the session is attached: the `session.detached`
     * and `session.deleted` frames are emitted after the map entry is gone and
     * therefore report "main" for a subagent. Harmless today — no client path
     * branches on sessionKind for those two methods.
     */
    getSessionKind(sessionId: SessionId): "main" | "subagent" {
        return this.attached.get(sessionId)?.sessionKind ?? "main";
    }

    async dispose(): Promise<void> {
        for (const sessionId of [...this.attached.keys()]) {
            await this.detach(sessionId);
        }
        this.removeAllListeners();
    }
}

/**
 * Namespace pi 0.85 writes `session.setName()` into. Before 0.85 the title was
 * a `{kind: "fact", fact: "name"}` entry; it is now a value record, so the
 * scanner below must match this namespace or every session reads as untitled.
 */
const SESSION_NAME_NAMESPACE = "pi.session.name";

/** Namespace taco writes per-session facts into. Mirrors SESSION_NAME_NAMESPACE. */
const SESSION_FACTS_NAMESPACE = "taco.session.facts";

/**
 * Single-pass JSONL scan: pulls the session's title and sidecar facts in one
 * read.
 *
 * `repo.open()` would give both via getters, but it builds a whole
 * `JsonlSessionStorage` first: every line parsed into an entry, plus `byId`
 * and `labelsById` maps over all of them. For `session.list` that is pure
 * waste — measured at ~5MB of garbage per call over a 258-file store (32MB on
 * disk), which drove the daemon into a GC spiral where `session.list` stopped
 * answering inside its 15s budget.
 *
 * Scanning cannot be short-circuited: a rename appends another name value,
 * and a fact rewrite appends another facts value. Both must reach EOF — but
 * only matching lines are parsed, and nothing but the winners is retained.
 *
 * Because the scan reads pi's private on-disk encoding (storage format 4 is
 * pre-stabilization; see pi spec §0.9), a silent miss on either field would
 * leave `session.list` showing untitled / un-fact'd sessions with no signal.
 * The parse-warn on zero hits turns silent breakage into an actionable log.
 */
async function readSessionMetadataFromDisk(
    path: string,
): Promise<{ name: string | undefined; facts: SessionFacts }> {
    // createReadStream + readline.createInterface is the standard streaming
    // pattern, but readline does NOT close the input stream on rl.close().
    // The file descriptor stays open and the underlying FSReqCallback never
    // fires its oncomplete — every cold start session.list that exercises
    // this path leaves one stranded FDRequest, and after a few dozen calls
    // the libuv thread pool is saturated by pending FSReqPromise objects
    // (measured: 35k+ on a 258-file store, event loop effectively wedged).
    // Destroy the input stream explicitly to release the fd.
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
    });
    let name: string | undefined;
    let facts: SessionFacts = {};
    let lineCount = 0;
    try {
        for await (const line of rl) {
            lineCount++;
            // Substring test before JSON.parse: the overwhelming majority of
            // lines are messages, and parsing them is exactly the cost this
            // function exists to avoid.
            if (!line.includes(SESSION_NAME_NAMESPACE) && !line.includes(SESSION_FACTS_NAMESPACE)) {
                continue;
            }
            try {
                const entry = JSON.parse(line) as {
                    kind?: string;
                    op?: string;
                    namespace?: string;
                    value?: unknown;
                };
                if (entry.kind !== "value" || entry.namespace === undefined) continue;
                // A cleared value is `op: "delete"` (or a non-typed value),
                // which must reset the winner rather than keep the previous
                // value.
                const cleared = entry.op === "delete";
                if (entry.namespace === SESSION_NAME_NAMESPACE) {
                    if (cleared || typeof entry.value !== "string") {
                        name = undefined;
                        continue;
                    }
                    name = entry.value.trim() || undefined;
                } else if (entry.namespace === SESSION_FACTS_NAMESPACE) {
                    if (cleared || typeof entry.value !== "object" || entry.value === null) {
                        facts = {};
                        continue;
                    }
                    facts = entry.value as SessionFacts;
                }
            } catch {
                // A torn last line (crash mid-append) must not fail the list.
                // Keep whatever earlier values we already found.
            }
        }
    } finally {
        rl.close();
        // Force the underlying file handle closed so libuv's request queue
        // does not accumulate stranded FSReqPromise objects. Without this,
        // session.list paths that scan many .jsonl files drive the daemon
        // heap up to multiple GB and the event loop stops accepting new
        // RPCs — see commit message for the wedge-detector measurements.
        if (!stream.destroyed) stream.destroy();
    }
    if (lineCount > 0 && name === undefined && Object.keys(facts).length === 0) {
        // Storage format 4 is pre-stabilization per pi spec §0.9; a silent
        // miss here would leave the list untitled with no signal. Warn so
        // a pi upgrade that renames the namespace is visible.
        log.warn("scanned jsonl found no name or facts lines; storage format may have changed", {
            path,
            lineCount,
        });
    }
    return { name, facts };
}
