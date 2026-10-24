/**
 * SessionRegistry — owns session lifecycle and state within a workspace.
 *
 * Responsibilities: holds repo / attached map / session facts cache;
 * session CRUD: list / open / rename / getHistory / delete;
 * attach / detach / attachChild (used by AgentSpawner);
 * forwards AttachedSession events as workspace-level `session.*` events.
 *
 * Not in this class: subagent spawn (AgentSpawner), model switching (ModelRegistry),
 * JSONL title/facts scanning (sessionMetadataReader), id-prefix resolution (sessionLookup).
 */

import { EventEmitter } from "node:events";
import type {
    InstructionsConfig,
    SessionId,
    SupportedLocale,
    WorkspaceId,
} from "@taco-ai/protocol";
import type {
    SubagentContextMode,
    SubagentProgressSink,
    SubagentSpawnContext,
} from "../../agents/types.ts";
import type { CheckpointStore } from "../../checkpoints/store.ts";
import type { ResolvedCompaction } from "../../config/config.ts";
import type { WorkspaceExtensionSet } from "../../extensions/index.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { MemoryStore } from "../../memory/index.ts";
import type { SkillReinjectorHandle } from "../../skills/skillReinjector.ts";
import type { SpawnSkillSubagentOptions } from "../../skills/skillTool.ts";
import { createSkillTool } from "../../skills/skillTool.ts";
import type { TacoSkill } from "../../skills/tacoSkill.ts";
import type { ImChannelContext } from "../../tags/index.ts";
import { type AgentTypeDescriptor, createAgentTool } from "../../tools/agent.ts";
import { createAgentAbortTool } from "../../tools/agentAbort.ts";
import { createAgentContinueTool } from "../../tools/agentContinue.ts";
import type { TacoToolContextBase } from "../../tools/context.ts";
import type { TacoTool } from "../../tools/index.ts";
import { AttachedSession } from "../harness/attachedSession.ts";
import type { DeferredToolRegistry } from "../harness/deferredToolRegistry.ts";
import type { NodeExecutionEnv } from "../pi/node.ts";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    Api,
    Entry,
    JsonlSessionMetadata,
    JsonlSessionRepo,
    Model,
    Models,
    PromptTemplate,
    Session,
    ThinkingLevel,
} from "../pi/types.ts";
import { findBranchEntries, findBranchTipId } from "./sessionBranch.ts";
import { readSessionFacts, type SessionFacts, writeSessionFactsIfAbsent } from "./sessionFacts.ts";
import { resolveSessionByPrefix, SessionNotFoundError } from "./sessionLookup.ts";
import { readLegacyFactsFromPath, readSessionMetadataFromDisk } from "./sessionMetadataReader.ts";
import { buildSessionTaskState, type SessionTaskState } from "./sessionTaskState.ts";
import { type TitleSource, writeTitleSource } from "./sessionTitleSource.ts";

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
    /**
     * A thunk, not a value: `WorkspaceRuntime.refreshToolset()` and
     * `reloadSkillsNow()` both rebuild the workspace's baked prompt after
     * construction. A captured string would leave a session attached after
     * one of those rebuilds with the *previous* prompt — the same tool/prompt
     * mismatch `refreshToolset` exists to prevent, just on the attach path
     * instead of the per-turn one.
     */
    readonly getSystemPrompt: () => string;
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
        /** Task label echoed on the background completion notice. */
        description?: string;
        context?: SubagentContextMode;
        background?: boolean;
        signal?: AbortSignal;
        onUpdate?: SubagentProgressSink;
    }) => Promise<{
        subSessionId?: SessionId;
        resultText: string;
        isError: boolean;
        background?: boolean;
    }>;
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
        onUpdate?: SubagentProgressSink;
    }) => Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        aborted?: boolean;
    }>;
    /** Skill subagent spawn callback (same deferred AgentSpawner pattern). */
    readonly spawnSkillSubagent: (
        opts: SpawnSkillSubagentOptions,
    ) => Promise<{ subSessionId?: string; resultText: string; isError: boolean }>;
    /**
     * Stop a running subagent by child session id. Same deferred AgentSpawner
     * pattern as the spawn callbacks; `forParentSessionId` restricts the
     * `agentAbort` tool to stopping the calling session's own children.
     * Optional so test harnesses that never abort can omit it (the tool then
     * reports "not running").
     */
    readonly abortSubagentRun?: (subSessionId: string, forParentSessionId?: SessionId) => boolean;
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
    /** Per-turn toolset convergence; returns undefined when nothing changed.
     *  Supplied by WorkspaceRuntime (which owns the prompt it rebuilds).
     *  `removed` lists the workspace-level names the change retired, so the
     *  session can drop exactly those instead of replacing its whole toolset. */
    readonly refreshToolset?: (
        sessionId: SessionId,
        taskState: SessionTaskState,
    ) => { tools: TacoTool[]; removed: string[]; systemPrompt: string } | undefined;
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
     * The workspace's associated directories, resolved on every use so a
     * grant added or removed mid-session reaches the next turn. Forwarded to
     * every AttachedSession so the `<associated_workspaces>` context hook can
     * read it on each LLM call.
     */
    readonly getAssociatedRoots?: () => readonly string[];
    /**
     * Per-turn tool context provider. Threaded straight through to every
     * AttachedSession's harness — the harness calls it once per turn to
     * resolve the `TacoToolContext` snapshot for that turn's tool calls.
     * WorkspaceRuntime wires this from `sessionCwd` + `dispatchRpc` +
     * `imRouting`; tests can pass an inline closure.
     *
     * Returns the workspace-level part only. The session identity is added
     * by the AttachedSession, which is the layer that knows it.
     */
    readonly getToolContext: () => TacoToolContextBase;
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
    private readonly getSystemPrompt: () => string;
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
    /**
     * The workspace's associated directories, resolved on every use so a
     * grant added or removed mid-session reaches the next turn.
     */
    readonly getAssociatedRoots?: () => readonly string[];
    /** Per-turn tool context provider (see options below). */
    readonly getToolContext: () => TacoToolContextBase;

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

    /**
     * sessionId → who last set the session's title ("auto" truncation/summary
     * vs explicit "user" rename). Same single-pass scan as name/facts.
     * `undefined` (cache miss aside) means no provenance was ever recorded —
     * treated as "user" by callers so a pre-existing title from before this
     * feature shipped is never silently overwritten.
     */
    private readonly _titleSourceCache = new Map<SessionId, TitleSource | undefined>();

    /**
     * sessionId → last user-visible message timestamp (epoch ms). Same scan
     * as name/facts; the list sorts on this instead of file mtime, which a
     * v3→v4 rewrite would otherwise bump.
     */
    private readonly _activityCache = new Map<SessionId, number | undefined>();

    /** sessionId → message records in the file. Same scan; see getSessionMessageCount. */
    private readonly _messageCountCache = new Map<SessionId, number>();

    /** Currently attached session map. */
    private readonly attached = new Map<SessionId, AttachedSession>();

    /**
     * Tail of the serialized pi-handle queue for each session id.
     *
     * pi's repo allows one open handle per id, so every path that would open
     * one — a detached read or an attach — queues here rather than only the
     * reads. The attach path is the one that made this necessary: a spawn
     * publishes `subagent.spawned` before it attaches, and the desktop asks for
     * that child's history as soon as it has the id, which used to open the
     * file under the attach and throw "Session is already open".
     *
     * Holds a rejection-swallowing promise, so it is a barrier only — never the
     * value a caller awaits. Entries are removed as each queue drains.
     */
    private readonly sessionSlots = new Map<SessionId, Promise<void>>();

    /**
     * Run `task` with exclusive use of `sessionId`'s pi handle slot.
     *
     * Not reentrant: a task already holding the slot must not call back into
     * `withSession`/`attachChild` for the same id and await the result, or it
     * waits on itself. Fire-and-forget callbacks started by an attach (crash
     * recovery, title summarization) are fine — they queue and run once the
     * attach releases the slot.
     */
    private async withSlot<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> {
        const previous = this.sessionSlots.get(sessionId);
        const run = (previous ?? Promise.resolve()).then(task);
        const settled = run.then(
            () => undefined,
            () => undefined,
        );
        this.sessionSlots.set(sessionId, settled);
        try {
            return await run;
        } finally {
            // Only the last link clears the entry, or a queue that is still
            // draining would lose its tail and let a new task run in parallel.
            if (this.sessionSlots.get(sessionId) === settled) {
                this.sessionSlots.delete(sessionId);
            }
        }
    }

    private readonly spawnSubagent: SessionRegistryOptions["spawnSubagent"];
    private readonly resumeSubagent: SessionRegistryOptions["resumeSubagent"];
    private readonly abortSubagentRun: (
        subSessionId: string,
        forParentSessionId?: SessionId,
    ) => boolean;
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
    private readonly refreshToolset:
        | ((
              sessionId: SessionId,
              taskState: SessionTaskState,
          ) => { tools: TacoTool[]; removed: string[]; systemPrompt: string } | undefined)
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
        this.getSystemPrompt = options.getSystemPrompt;
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
        this.getAssociatedRoots = options.getAssociatedRoots;
        this.getToolContext = options.getToolContext;
        this.spawnSubagent = options.spawnSubagent;
        this.resumeSubagent = options.resumeSubagent;
        this.abortSubagentRun = options.abortSubagentRun ?? (() => false);
        this.spawnSkillSubagent = options.spawnSkillSubagent;
        this.availableAgentTypes = options.availableAgentTypes;
        this.skills = options.skills;
        this.skillAuthoringGuidance = options.skillAuthoringGuidance;
        this.memoryStore = options.memoryStore;
        this.isIm = options.isIm;
        this.toolsBuilder = options.toolsBuilder;
        this.refreshToolset = options.refreshToolset;
    }

    getListingTools(): TacoTool[] {
        const listing: TacoTool[] = [];
        const listingCtx: SubagentSpawnContext = {
            spawn: () => Promise.reject(new Error("tools.list stub: not executable")),
            continue: () => Promise.reject(new Error("tools.list stub: not executable")),
            abortSubagent: () => ({ stopped: false }),
        };
        listing.push(createAgentTool(listingCtx, [...this.availableAgentTypes]));
        listing.push(createAgentContinueTool(listingCtx));
        listing.push(createAgentAbortTool(listingCtx));
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
        this._activityCache.clear();
        this._titleSourceCache.clear();
        this._messageCountCache.clear();
    }

    /** Get an existing session instance by id. */
    async openSession(sessionId: SessionId): Promise<JsonlSessionMetadata> {
        let resolution = resolveSessionByPrefix(await this.listSessions(), sessionId);
        if (resolution.kind === "not_found") {
            // A miss is only proof of absence against a fresh, non-empty read:
            // the cache can predate a session another writer created, and an
            // empty list is how a transient repo.list failure looks (see
            // listSessions). Clients prune rows on SessionNotFoundError.
            this._metadataCache = null;
            const fresh = await this.listSessions();
            resolution = resolveSessionByPrefix(fresh, sessionId);
            if (resolution.kind === "not_found") {
                if (fresh.length === 0) {
                    throw new Error(`session not found: ${sessionId} (session list empty)`);
                }
                throw new SessionNotFoundError(sessionId);
            }
        }
        if (resolution.kind === "ambiguous") {
            throw new Error(`session id prefix is ambiguous: ${sessionId}`);
        }
        return resolution.meta;
    }

    /**
     * Create a session file under the same per-id slot as reads and attaches.
     *
     * pi registers the id in its open-session map from `create()` until the
     * returned handle closes, and a background spawn's launch receipt names its
     * child before that window ends. A reader that resolves the id early queues
     * here instead of racing the open — and instead of winning the slot first,
     * which makes `create()` fail and delete the file it just wrote.
     */
    async createSession(
        id: SessionId,
        parentSessionId: SessionId | undefined,
        writeFacts: (session: Session) => Promise<void>,
    ): Promise<void> {
        await this.withSlot(id, async () => {
            const session = await this.repo.create(
                { id, cwd: this.sessionCwd, parentSessionId },
                harnessContext,
            );
            try {
                await writeFacts(session);
            } finally {
                // The handle owns pi's slot; a failed facts write must not
                // leave it open for the rest of the process.
                await session.close(harnessContext);
            }
        });
        this.invalidateListCache();
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
     *
     * A detached read queues behind any in-flight attach of the same id (and
     * vice versa): an attach opens the handle before it becomes visible in
     * `attached`, and a spawn announces its child before that, so the desktop's
     * history pull routinely lands inside that window. The attached path is
     * deliberately left unserialized: it opens nothing, and it is on the hot
     * path of every spawn.
     */
    async withSession<T>(sessionId: SessionId, read: (session: Session) => Promise<T>): Promise<T> {
        const attached = this.attached.get(sessionId);
        if (attached) return read(attached.session);
        return this.withSlot(sessionId, async () => {
            // The attach we queued behind may have finished; its handle is the
            // one to read — opening our own would hit the same guard.
            const nowAttached = this.attached.get(sessionId);
            if (nowAttached) return read(nowAttached.session);
            return this.readPersistedSession(sessionId, read);
        });
    }

    /** `withSession`'s detached branch: open, read, always release the slot. */
    private async readPersistedSession<T>(
        sessionId: SessionId,
        read: (session: Session) => Promise<T>,
    ): Promise<T> {
        const session = await this.openPersistedSession(sessionId);
        try {
            return await read(session);
        } finally {
            await session.close(harnessContext);
        }
    }

    /**
     * Open a session file, restoring taco facts that pi's v3→v4 importer drops.
     *
     * Must run *before* `repo.open()`: that call rewrites a v3 file in place and
     * the free-form `metadata` bag is gone afterwards. Header `parentSessionId`
     * (atomic with `repo.create()`) is the fallback for a 0.85 child whose facts
     * write was interrupted.
     *
     * The extra first-line read is intentional and cheap relative to the full
     * `repo.open()` that follows. There is no "already v4" skip: v4 files return
     * undefined immediately after parsing the header. Destroy the first-line
     * stream in `readFirstLine` so this cannot accumulate stranded FDs the way
     * an earlier unclosed scanner once did.
     */
    private async openPersistedSession(sessionId: SessionId): Promise<Session> {
        const meta = await this.openSession(sessionId);
        const recovered = await readLegacyFactsFromPath(meta.path);
        const session = await this.repo.open(meta, harnessContext);
        try {
            const facts =
                recovered ??
                (meta.parentSessionId !== undefined
                    ? { kind: "subagent" as const, parentSessionId: meta.parentSessionId }
                    : undefined);
            if (facts !== undefined) {
                const wrote = await writeSessionFactsIfAbsent(session, facts);
                this._factsCache.set(sessionId, wrote ? facts : await readSessionFacts(session));
            }
            return session;
        } catch (error) {
            // From here on the handle owns pi's slot. A facts write can fail on
            // a read-only or full disk, and leaving the handle open would fail
            // every later read and attach of this id for the rest of the
            // process. Close failures must not mask the real error.
            await session.close(harnessContext).catch(() => undefined);
            throw error;
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
     *
     * Always records provenance as "user" — this is the RPC an explicit
     * rename goes through (desktop rename modal, `session.rename`). Callers
     * that write an auto-generated title (truncation placeholder, LLM
     * summary) must not go through this method; see `setPlaceholderTitle` /
     * `setSummaryTitle`.
     */
    async renameSession(sessionId: SessionId, name: string): Promise<void> {
        await this.writeTitle(sessionId, name, "user");
    }

    /**
     * Write the truncation-placeholder title (first ~60 chars of the latest
     * message), but only while nothing better exists yet.
     *
     * A session with no name yet has no titleSource either — that
     * combination is "never titled," not "owned by someone else," and must
     * accept the placeholder. What must block the write is an *existing
     * name* with a source other than "placeholder": a user rename, an LLM
     * summary (TitleSummarizer, strictly better than a raw truncation of
     * whatever the user typed most recently), or a name written before this
     * feature shipped (no titleSource recorded at all) — none of those may
     * be silently overwritten by a later message's truncation.
     *
     * Returns whether the write happened, so callers can skip the
     * `_nameCache` update / list invalidation on a no-op.
     */
    async setPlaceholderTitle(sessionId: SessionId, name: string): Promise<boolean> {
        const [existingName, source] = await Promise.all([
            this.getSessionName(sessionId),
            this.getTitleSource(sessionId),
        ]);
        if (existingName !== undefined && source !== "placeholder") return false;
        return await this.writeTitle(sessionId, name, "placeholder");
    }

    /**
     * Write the LLM-generated summary title (TitleSummarizer, triggered on
     * every completed `run_end`).
     *
     * Re-summarizing is the point: a title derived from the opening message
     * stops describing a conversation that has moved on. So "summary" is an
     * accepted prior source, unlike in `setPlaceholderTitle`. Only "user"
     * refuses — an explicit rename is permanent, and re-deriving over it
     * would discard a deliberate choice.
     *
     * An unchanged name short-circuits in `writeTitle`, so a stable topic
     * costs no append and fires no push.
     *
     * Returns whether the write happened.
     */
    async setSummaryTitle(sessionId: SessionId, name: string): Promise<boolean> {
        const source = await this.getTitleSource(sessionId);
        if (source === "user") return false;
        return await this.writeTitle(sessionId, name, "summary");
    }

    /**
     * Shared write path for every title source.
     *
     * Skips the append when name and source both already hold — the session
     * log is append-only, so re-running summarization on a conversation whose
     * topic has not moved would otherwise add one record per turn and push a
     * `session.renamed` frame that changes nothing. Reads go through
     * `getSessionName` / `getTitleSource` rather than the caches directly, so
     * a cold cache hydrates from disk instead of comparing against
     * `undefined` and always writing.
     *
     * Returns whether the write happened.
     */
    private async writeTitle(
        sessionId: SessionId,
        name: string,
        source: TitleSource,
    ): Promise<boolean> {
        const [currentName, currentSource] = await Promise.all([
            this.getSessionName(sessionId),
            this.getTitleSource(sessionId),
        ]);
        if (currentName === name && currentSource === source) return false;
        await this.withSession(sessionId, async (session) => {
            await session.setName(name, harnessContext);
            await writeTitleSource(session, source, harnessContext);
        });
        this._nameCache.set(sessionId, name);
        this._titleSourceCache.set(sessionId, source);
        // Same forward-to-facade path as the other session.* events: the server
        // turns this into a `session.renamed` push. Emitted for every source,
        // including "user" — a second client window did not make that rename
        // and has no other way to learn about it.
        this.emit("session.renamed", { sessionId, name });
        return true;
    }

    /** Read the current title of a session (last name value), or undefined. Cache-hit avoids disk I/O. */
    async getSessionName(sessionId: SessionId): Promise<string | undefined> {
        if (this._nameCache.has(sessionId)) {
            return this._nameCache.get(sessionId);
        }
        await this.hydrateSessionMetadata(sessionId);
        return this._nameCache.get(sessionId);
    }

    /** Who last set this session's title — see `_titleSourceCache` for the `undefined` contract. */
    async getTitleSource(sessionId: SessionId): Promise<TitleSource | undefined> {
        if (this._titleSourceCache.has(sessionId)) {
            return this._titleSourceCache.get(sessionId);
        }
        await this.hydrateSessionMetadata(sessionId);
        return this._titleSourceCache.get(sessionId);
    }

    /**
     * Read the sidecar's durable facts for a session (kind / agentType / depth /
     * parent linkage).
     *
     * pi 0.85 fixed the session metadata shape, so these live in the value
     * store on disk and are read via the same JSONL stream as the session
     * title. Both populate a per-session cache so a `session.list` that needs
     * both pays one scan per session rather than two.
     */
    async getSessionFacts(sessionId: SessionId): Promise<SessionFacts> {
        if (this._factsCache.has(sessionId)) {
            return this._factsCache.get(sessionId) ?? {};
        }
        await this.hydrateSessionMetadata(sessionId);
        return this._factsCache.get(sessionId) ?? {};
    }

    /**
     * Last user-visible message timestamp for a session, in epoch ms.
     *
     * Used as `updatedAt` on the session list so a format rewrite cannot
     * masquerade as recent activity. `undefined` when the file has no
     * messages — callers fall back to `createdAt`.
     */
    async getSessionActivityAt(sessionId: SessionId): Promise<number | undefined> {
        if (this._activityCache.has(sessionId)) {
            return this._activityCache.get(sessionId);
        }
        await this.hydrateSessionMetadata(sessionId);
        return this._activityCache.get(sessionId);
    }

    /**
     * Message records in the session file, from the same scan. An estimate
     * for client loading placeholders: it counts abandoned branches too.
     */
    async getSessionMessageCount(sessionId: SessionId): Promise<number | undefined> {
        if (this._messageCountCache.has(sessionId)) {
            return this._messageCountCache.get(sessionId);
        }
        await this.hydrateSessionMetadata(sessionId);
        return this._messageCountCache.get(sessionId);
    }

    /** One JSONL scan fills name, facts, activity, title-source and count caches together. */
    private async hydrateSessionMetadata(sessionId: SessionId): Promise<void> {
        const meta = await this.openSession(sessionId);
        const { name, facts, activityAt, titleSource, messageCount } =
            await readSessionMetadataFromDisk(meta.path);
        this._nameCache.set(sessionId, name);
        this._factsCache.set(sessionId, facts);
        this._activityCache.set(sessionId, activityAt);
        this._messageCountCache.set(sessionId, messageCount);
        this._titleSourceCache.set(sessionId, titleSource);
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
                    // Dropping this silently stripped the background completion
                    // notice of its task label — forward everything the context
                    // type declares.
                    description: args.description,
                    context: args.context,
                    background: args.background,
                    signal: args.signal,
                    onUpdate: args.onUpdate,
                }),
            continue: (args) =>
                this.resumeSubagent({
                    parentSessionId: sessionId,
                    parentToolCallId: args.parentToolCallId,
                    subSessionId: args.subSessionId,
                    prompt: args.prompt,
                    signal: args.signal,
                    onUpdate: args.onUpdate,
                }),
            // Restricted to this session's own children: the model knows only
            // its own subagent ids, but a guessed id must not stop another
            // session's run.
            abortSubagent: (args) => ({
                stopped: this.abortSubagentRun(args.subSessionId, sessionId),
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
            createAgentAbortTool(spawnContext),
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
        // task/plan state). Kept outside the slot: it is directory I/O and
        // never touches pi's handle.
        const resolvedTaskState =
            taskState ?? (await buildSessionTaskState(sessionId, this.sessionsRoot));

        // Serialized with detached reads: the spawn announces its child before
        // this runs, so the desktop's `session.history` pull queues here and
        // reuses the attached handle instead of racing the open.
        return await this.withSlot(sessionId, async () => {
            // A queued read may have attached it, or another attach may have
            // won the slot while this one waited.
            const nowExisting = this.attached.get(sessionId);
            if (nowExisting) return nowExisting;

            const session = await this.openPersistedSession(sessionId);
            let attached: AttachedSession;
            try {
                const facts = await readSessionFacts(session);
                const sessionKind: "main" | "subagent" =
                    facts.kind === "subagent" ? "subagent" : "main";
                attached = await AttachedSession.create({
                    session,
                    models: this.models,
                    env: this.env,
                    model: opts.model ?? this.defaultModel,
                    systemPrompt: systemPrompt ?? this.getSystemPrompt(),
                    tools,
                    resources: this.resources,
                    streamOptions: this.streamOptions,
                    thinkingLevel: opts.thinkingLevel ?? this.defaultThinkingLevel,
                    compaction: this.compaction,
                    extensionContextHooks: this.extensions?.contextHooks(),
                    extensionToolCallHooks: this.extensions?.toolCallHooks(),
                    extensionToolResultHooks: this.extensions?.toolResultHooks(),
                    defaultUiLocale: this.defaultUiLocale,
                    getSkills: () => this.skills,
                    memoryStore: this.memoryStore,
                    isIm: this.isIm,
                    setSummaryTitle: (id, name) => this.setSummaryTitle(id, name),
                    taskStore: resolvedTaskState.taskStore,
                    planState: resolvedTaskState.planState,
                    tasksDir: resolvedTaskState.tasksDir,
                    checkpointStore: this.checkpointStore,
                    toolRegistry: this.toolRegistry,
                    // Main sessions only: a subagent's toolset is deliberately narrowed
                    // by its caller (depth-filtered, `agent` removed), so re-imposing
                    // the workspace set on it would widen it back.
                    refreshToolset:
                        sessionKind === "main" && this.refreshToolset
                            ? () => this.refreshToolset?.(sessionId, resolvedTaskState)
                            : undefined,
                    getInstructionsConfig: this.getInstructionsConfig,
                    getImChannelContext: this.getImChannelContext,
                    getAssociatedRoots: this.getAssociatedRoots,
                    getToolContext: this.getToolContext,
                    sessionCwd: this.sessionCwd,
                    sessionKind,
                });
            } catch (error) {
                // The handle owns pi's slot until it closes. A failed attach
                // that left it open would make every later read and attach of
                // this id fail with "Session is already open".
                await session.close(harnessContext).catch(() => undefined);
                throw error;
            }

            this.attached.set(sessionId, attached);

            // Forward harness events to workspace-level events
            attached.on("event", (e) => this.emit("session.event", { sessionId, event: e }));
            attached.on("error", (e) => this.emit("session.error", { sessionId, error: e }));

            // Emit a one-shot attached push event
            this.emit("session.attached", { sessionId });

            return attached;
        });
    }

    async detach(sessionId: SessionId): Promise<void> {
        await this.withSlot(sessionId, () => this.detachLocked(sessionId));
    }

    /** `detach` body; the caller must hold the id's slot. */
    private async detachLocked(sessionId: SessionId): Promise<void> {
        const attached = this.attached.get(sessionId);
        if (!attached) return;
        await attached.dispose();
        this.attached.delete(sessionId);
        this.emit("session.detached", { sessionId });
    }

    /** Delete a session: detach first (if attached) to release the harness, then delete the underlying .jsonl. */
    async deleteSession(sessionId: SessionId): Promise<void> {
        // Detach and removal share one slot: releasing it between them lets an
        // attach queued behind the detach reopen the handle, and pi's `delete`
        // then throws "Session is open".
        await this.withSlot(sessionId, async () => {
            await this.detachLocked(sessionId);
            const meta = await this.openSession(sessionId);
            await this.repo.delete(meta, harnessContext);
        });
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

    /** Let a non-harness child (claude-code) mark itself as a subagent for push routing. */
    noteSessionKind(sessionId: SessionId, kind: "main" | "subagent"): void {
        this._factsCache.set(sessionId, {
            ...(this._factsCache.get(sessionId) ?? {}),
            kind,
        });
    }

    /**
     * Synchronously classify a session for server.emitPush's frame stamping.
     * Attached sessions use their live harness kind; non-harness children use
     * the kind cached when their facts were written.
     */
    getSessionKind(sessionId: SessionId): "main" | "subagent" {
        const attached = this.attached.get(sessionId);
        if (attached) return attached.sessionKind;
        // A claude-code subagent never attaches — there is no pi harness — so
        // its kind only lives in the facts cache, populated when the spawner
        // writes facts or when a read path hydrates the session. Fall back to
        // it so frames pushed for that session still route as "subagent".
        const facts = this._factsCache.get(sessionId);
        if (facts?.kind === "subagent") return "subagent";
        return "main";
    }

    async dispose(): Promise<void> {
        for (const sessionId of [...this.attached.keys()]) {
            await this.detach(sessionId);
        }
        this.removeAllListeners();
    }
}
