/**
 * AttachedSession — binds one session to an AgentHarness.
 * Forwards harness events/errors as "event"/"error", wraps prompt / steer /
 * abort / setModel, delegates compaction to CompactionController and context
 * usage to ContextInfoService. Hook wiring lives in `./hookWiring.ts`.
 * dispose() aborts the harness and releases all listeners/subscriptions.
 */

import { EventEmitter } from "node:events";
import type {
    InstructionsConfig,
    AgentMessage as ProtocolAgentMessage,
    SessionCompactResult,
    SessionContextInfoResult,
    SupportedLocale,
    WorkspaceId,
} from "@taco-ai/protocol";
import { CheckpointManager } from "../checkpoints/manager.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import type { ResolvedCompaction } from "../config/config.ts";
import type {
    ContextHookBuckets,
    ToolCallHook,
    ToolResultHookBuckets,
} from "../extensions/index.ts";
import { harnessContext } from "../lib/harnessContext.ts";
import { createLogger } from "../lib/logger.ts";
import { MemoryExtractorImpl, type MemoryStore, sliceForExtraction } from "../memory/index.ts";
import type { PlanModeState } from "../plan/planModeState.ts";
import type { NodeExecutionEnv } from "../runtime/pi/node.ts";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    AgentLane,
    AgentMessage,
    Api,
    Entry,
    HarnessEvent,
    ImageContent,
    Model,
    Models,
    OpenOperation,
    PromptTemplate,
    Session,
    ThinkingLevel,
} from "../runtime/pi/types.ts";
import {
    AgentHarness,
    laneConfig,
    NoActiveOperation,
    NothingToResume,
} from "../runtime/pi/values.ts";
import type { SkillReinjectorHandle } from "../skills/skillReinjector.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import type { ImChannelContext } from "../tags/index.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";
import { createAddToolsTool } from "../tools/addTools.ts";
import type { TacoToolContext } from "../tools/context.ts";
import type { TacoTool } from "../tools/index.ts";
import {
    COMPACTION_END_EVENT,
    COMPACTION_START_EVENT,
    CompactionController,
} from "./compactionController.ts";
import { ContextInfoService } from "./contextInfoService.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import { toHarnessError, toTerminalError } from "./harnessErrors.ts";
import { wireHarnessHooks } from "./hookWiring.ts";
import { PinOnceConsumer } from "./pinOnceConsumer.ts";
import { sidecarVersion } from "./runtimeResources.ts";
import { buildBranchContext, findBranchEntries, MAIN_BRANCH } from "./sessionBranch.ts";
import {
    DefaultSessionToolController,
    type SessionToolController,
} from "./sessionToolController.ts";

const log = createLogger("attachedSession");

/**
 * Harness event types republished onto the session's "event" stream.
 *
 * pi 0.85 replaced the catch-all `harness.subscribe(cb)` with a typed
 * per-event bus, so the set of forwarded events is now explicit. These are the
 * types the desktop renders: streaming assistant output, tool-call lifecycle,
 * turn/run boundaries, queue depth, retry status and usage.
 *
 * Deliberately omitted: `handler_error` and `fault` (internal diagnostics that
 * are logged, not surfaced), `entry_added` (redundant with `message_*`),
 * `lane_created` / `value_update` / `config_update` (no UI), and the
 * `compaction_*` pair, which CompactionController republishes with its own
 * paired lifecycle signal so the push adapter's interlock stays intact.
 */
const REPUBLISHED_EVENTS = [
    "run_start",
    "run_end",
    "run_suspend",
    "run_resume",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_start",
    "tool_update",
    "tool_end",
    "queue_update",
    "retry_scheduled",
    "retry_start",
    "retry_end",
    "operation_abort",
    "navigation_start",
    "navigation_end",
    "usage",
] as const satisfies readonly HarnessEvent["type"][];

export interface AbortResult {
    clearedSteer: AgentMessage[];
    clearedFollowUp: AgentMessage[];
}

/**
 * What happened to one operation that a previous process left in flight.
 *
 * `status` is about the recovery attempt, not the operation's own result:
 *
 *   - `recovered` — resume drove it to a terminal state; the lane is usable.
 *     `outcome` carries pi's own status ("completed" / "aborted" / "suspended").
 *   - `already_settled` — it finished between `create()` reporting it and the
 *     resume call. Benign race, nothing was done.
 *   - `failed` — resume could not drive it. The lane may still be occupied, so
 *     this is the case that leaves a session needing manual intervention.
 *   - `skipped` — the entry belonged to another lane, which this session cannot
 *     resume (`lane.resume()` only recovers its own lane).
 */
export interface RecoveryOutcome {
    readonly operationId: string;
    readonly lane: string;
    readonly kind: OpenOperation["kind"];
    readonly status: "recovered" | "already_settled" | "failed" | "skipped";
    /** pi's terminal status when `status` is `recovered`. */
    readonly outcome?: string;
    /** Failure detail when `status` is `failed`. */
    readonly error?: string;
}

/**
 * Tag provider requests with the sidecar version.
 *
 * `user-agent: taco/<version>` — set on every NON-OAuth provider. OAuth
 * providers (Anthropic OAuth in particular) need their
 * `claude-cli/<version>` identity preserved: pi-ai's openai / anthropic
 * SDKs read `this.constructor.name` for the default UA, and overriding
 * with `taco/<version>` would lose Claude Code's OAuth beta features.
 * The OAuth check uses `checkAuth` (never triggers a token refresh)
 * rather than `getAuth`.
 *
 * `x-taco-sidecar-version: <version>` — set on EVERY provider. It's
 * metadata, not identity, so it never conflicts with the OAuth UA. On
 * an OAuth call it's the only taco tag that survives, which is enough
 * to attribute the request to a taco version in the provider's logs.
 *
 * If `checkAuth` cannot classify the provider we skip the UA override
 * but still attach the version header — the version is safe; the UA
 * is the identity-bearing field.
 */
export async function withTacoUserAgent(
    streamOptions: AgentHarnessStreamOptions,
    models: Models,
    provider: string,
): Promise<AgentHarnessStreamOptions> {
    let skipUserAgent = false;
    try {
        const authCheck = await models.checkAuth(provider);
        skipUserAgent = authCheck?.type === "oauth";
    } catch {
        // Credential-store failures must not block attach; safe to drop
        // the UA override (we don't know if it would override an OAuth
        // identity) but keep the version header — it's metadata only.
        skipUserAgent = true;
    }

    const version = sidecarVersion();
    // Strip any caller-supplied `user-agent` on the OAuth path. pi-ai
    // hardcodes `claude-cli/<version>` for Anthropic OAuth to keep Claude
    // Code's OAuth beta features enabled, and a caller's UA in
    // `streamOptions.headers` would otherwise survive the spread and
    // override it (we are the last merge layer before pi-ai's defaults).
    const callerHeaders = { ...streamOptions.headers };
    if (skipUserAgent) delete callerHeaders["user-agent"];

    const tags: Record<string, string> = {
        "x-taco-sidecar-version": version,
        ...(skipUserAgent ? {} : { "user-agent": `taco/${version}` }),
    };

    return {
        ...streamOptions,
        headers: {
            ...callerHeaders,
            ...tags,
        },
    };
}

export interface AttachedSessionOptions {
    session: Session;
    models: Models;
    env: NodeExecutionEnv;
    /** Harness default model; create() throws when undefined (callers must set defaultModel before attach). */
    model?: Model<Api>;
    /** System prompt; WorkspaceRuntime always supplies one via buildSystemPrompt. */
    systemPrompt: string;
    tools: TacoTool[];
    resources: AgentHarnessResources<TacoSkill, PromptTemplate>;
    streamOptions: AgentHarnessStreamOptions;
    /**
     * Initial harness thinking level; defaults to `"off"`.
     * Change it after attach via `setThinkingLevel()`.
     */
    thinkingLevel?: ThinkingLevel;
    /**
     * Context hooks contributed by extensions (built-in templates
     * and external). Each is registered with harness.on("context", hook)
     * after the protocol-level hooks (dropPolicy / stripThinking) and
     * before the debug hook. See design §6.4.
     */
    extensionContextHooks?: ContextHookBuckets;
    /** Tool-call interceptors from extensions. Registered after context hooks. */
    extensionToolCallHooks?: ToolCallHook[];
    /** Tool-result interceptors, bucketed by source. Built-ins run first in
     *  the pipeline so external hooks can post-process (or further redact)
     *  the already-builtin-scrubbed output. See design §6.4. */
    extensionToolResultHooks?: ToolResultHookBuckets;
    /**
     * UI locale fallback, usually from WorkspaceRuntime config. Read by the hook
     * when prompt/steer carries no explicit uiLocale. See replyLanguage.ts.
     */
    defaultUiLocale?: SupportedLocale;
    /** Loaded skills — passed through to the skill body reinjector hook. */
    skills?: readonly TacoSkill[];
    /**
     * Auto-compaction policy. After the harness settles (with nextTurnCount=0),
     * `maybeCompact()` derives reserveTokens from `model.contextWindow * threshold`,
     * calls `shouldCompact()`, and awaits `harness.compact()` on a hit.
     * Defaults to `{ enabled: true, threshold: 0.7 }`.
     */
    compaction?: ResolvedCompaction;
    /**
     * Lazy accessor for the current `InstructionsConfig` (CLAUDE.md /
     * AGENTS.md / DESIGN.md). Invoked on every LLM call by the instructions
     * context hook so a `settings.write` patch takes effect without
     * re-attaching the session. `undefined` means "use defaults".
     */
    getInstructionsConfig?: () => InstructionsConfig | undefined;
    /**
     * Lazy accessor for the current IM channel identity (platform type +
     * configured instance id), supplied by the workspace. `undefined` for
     * non-IM workspaces. Passed through to wireHarnessHooks on every LLM call
     * so a settings.write reconfiguration is reflected on the next turn.
     */
    getImChannelContext?: () => ImChannelContext | undefined;
    /** User-level memory store — drives extraction + context injection. */
    memoryStore?: MemoryStore;
    /** True for IM workspaces; disables memory extraction regardless of store. */
    isIm?: boolean;
    /**
     * Per-session task/plan state (built and hydrated at attach time). Assigned
     * onto the instance inside create() before wireHarnessHooks, so hook thunks
     * can read it.
     */
    taskStore: TaskStore;
    planState: PlanModeState;
    tasksDir: string;
    /**
     * Workspace-shared checkpoint store. When present, create() builds a
     * per-session CheckpointManager so pre-write snapshots are attributable to
     * the session that made the edits.
     */
    checkpointStore?: CheckpointStore;
    /**
     * Dynamic-tool candidate directory. When provided, the session wires a resident
     * AddTools tool and can load deferred candidates on demand.
     * Absent = no dynamic-tool capability.
     */
    toolRegistry?: DeferredToolRegistry;
    /**
     * Per-turn `TacoToolContext` provider. The harness invokes it once per
     * turn snapshot and threads the result into every tool's `execute`.
     * Workspace-supplied; lazy so future hot-reload flows (imRouting /
     * dispatchRpc swaps) take effect on the next turn without reattaching.
     */
    getToolContext: () => TacoToolContext;
    /** Workspace cwd the tool context should be anchored to. */
    sessionCwd: WorkspaceId;
    /**
     * Subagent vs main-session classification, read from session facts by
     * `attachChild` and stamped onto every push frame by server.emitPush.
     * Carried on the AttachedSession rather than a parallel SessionRegistry
     * map so the runtime cache has a single writer.
     */
    sessionKind: "main" | "subagent";
}

/**
 * Whether `prompt()` should accept a branch-tip entry as a valid reply, or
 * surface the "expected an assistant reply" anomaly.
 *
 * The expected shape is an assistant message. The exception is a toolResult
 * entry whose `MessageEntry.terminate` is `true` — pi 0.85 lets a turn finish
 * on such an entry (askUser / planExit-style close) and reports
 * `status: "completed"` with the toolResult as the branch tip. Returning it
 * directly keeps the desktop from seeing a misleading error and from
 * `sessionDelete`-ing the freshly created session in its `sessionPrompt` catch.
 *
 * Any other non-assistant tip (a toolResult without `terminate`, a
 * compaction / branch_summary entry, an aborted-and-resumed anomaly) is a real
 * shape problem and is rejected — silent acceptance would mask upstream
 * invariant changes.
 *
 * `entry` is typed as pi's own `Entry` union rather than `unknown` so that a
 * rename of `MessageEntry.terminate` upstream breaks the build here instead of
 * silently degrading to "always reject" (which would reinstate the bug).
 */
export function resolvePromptReply(
    reply: AgentMessage | undefined,
    entry: Entry | undefined,
): "accept" | "reject" {
    if (reply === undefined) return "reject";
    if (reply.role === "assistant") return "accept";
    const terminating =
        entry?.type === "message" && entry.terminate === true && reply.role === "toolResult";
    return terminating ? "accept" : "reject";
}

export class AttachedSession extends EventEmitter {
    readonly session: Session;
    /**
     * Operations left in flight by a previous process, surfaced as `open[]`
     * by pi's `AgentHarness.create()`. Empty when the session is fresh or
     * already settled before attach.
     *
     * A snapshot of what attach *found*, not of what is still pending:
     * `resumeOpenOperations` drives these immediately afterwards, so a non-empty
     * array does NOT mean the lane is stuck. Read `recoveryOutcomes` for how
     * each one actually ended. Nothing on the wire or in the desktop UI reads
     * either field; both exist for structured logging and post-mortems.
     */
    resumableOperations: ReadonlyArray<OpenOperation>;
    /**
     * How each interrupted operation ended once recovery ran.
     *
     * Empty until recovery finishes (and forever, when there was nothing to
     * recover). This is the field worth looking at after a crash: it separates
     * "recovered cleanly" from "could not be recovered", which is the difference
     * between a session that works and one the user has to abort by hand.
     */
    recoveryOutcomes: ReadonlyArray<RecoveryOutcome> = [];
    readonly sessionKind: "main" | "subagent";
    /**
     * Session-wide configuration and the hook/event registries.
     *
     * pi 0.85 splits the old AgentHarness in two: the harness owns tools,
     * resources, stream options and the hook/event buses; a lane owns the
     * conversation (prompt / steer / abort / compact / model / thinking).
     * Both are needed, so both are held.
     */
    private readonly harness: AgentHarness<TacoToolContext>;
    /** The conversation lane. One per session — the harness's default "main". */
    private readonly lane: AgentLane;
    private uiLocale: SupportedLocale | undefined;
    private readonly defaultUiLocale: SupportedLocale | undefined;
    /**
     * Cached thinking level. Mirrors the lane's configuration so the
     * strip-thinking context hook can read it synchronously — pi 0.85's lane
     * getter is async. Only `setThinkingLevel` mutates it.
     */
    private thinkingLevel: ThinkingLevel;
    private unsubscribe?: () => void;
    /**
     * In-flight recovery of operations interrupted by a previous process.
     *
     * `create()` does not await it — a resumed run takes as long as a normal
     * turn and attach must stay fast — but the lane holds the recovered
     * operation until it settles, so anything that starts a run has to wait for
     * this first or it gets `LaneBusy`. Cleared once recovery finishes.
     */
    private recovery: Promise<void> | undefined;
    /** Per-session handle to push state into the skill reinjector; undefined if no skills. */
    skillReinjector: SkillReinjectorHandle | undefined;
    /** Fire-and-forget memory extractor (undefined when no memory store). */
    private memoryExtractor: MemoryExtractorImpl | undefined;
    private readonly compactionController: CompactionController;
    private readonly contextInfo: ContextInfoService;
    /** Turn-scoped snapshot policy; undefined when checkpoints are disabled. */
    checkpoints: CheckpointManager | undefined;
    /** Per-session task/plan state (hydrated at attach); read by hooks and pushes. */
    taskStore!: TaskStore;
    planState!: PlanModeState;
    tasksDir!: string;
    /**
     * Coordinator state for the "remember → extract incremental" protocol.
     * `tool_end("memory")` stores a Promise; `turn_end` chains off
     * it via the microtask queue so it never double-extracts or skips an offset.
     * If no remember tool fired, the field is `undefined` and extraction covers
     * the full conversation.
     */
    private lastRememberMessageCountPromises: Promise<number>[] = [];
    /** Dynamic-tool controller; undefined when no toolRegistry is configured. */
    readonly toolController: SessionToolController | undefined;
    /**
     * Lazy accessor for the current `InstructionsConfig`. Stored on the
     * session so the instructions context hook can read the latest config
     * (post-`settings.write`) on every LLM call. Underscore suffix avoids
     * the public method name `getInstructionsConfig` below.
     */
    private readonly getInstructionsConfig_: () => InstructionsConfig | undefined;

    private constructor(
        session: Session,
        harness: AgentHarness<TacoToolContext>,
        lane: AgentLane,
        thinkingLevel: ThinkingLevel,
        defaultUiLocale: SupportedLocale | undefined,
        compactionController: CompactionController,
        contextInfo: ContextInfoService,
        toolController: SessionToolController | undefined,
        getInstructionsConfig: () => InstructionsConfig | undefined,
        resumableOperations: ReadonlyArray<OpenOperation>,
        sessionKind: "main" | "subagent",
    ) {
        super();
        this.session = session;
        this.harness = harness;
        this.lane = lane;
        this.thinkingLevel = thinkingLevel;
        this.defaultUiLocale = defaultUiLocale;
        this.compactionController = compactionController;
        this.contextInfo = contextInfo;
        this.toolController = toolController;
        this.getInstructionsConfig_ = getInstructionsConfig;
        this.resumableOperations = resumableOperations;
        this.sessionKind = sessionKind;
    }

    /** Delegates to compactionController.effectiveCompaction() — the pin-aware hook in hookWiring uses the same threshold. */
    effectiveCompaction() {
        return this.compactionController.effectiveCompaction();
    }

    /**
     * Read the current `InstructionsConfig` — invoked by the instructions
     * context hook on every LLM call. Returns `undefined` (= use defaults)
     * when no accessor was supplied at construction.
     */
    getInstructionsConfig(): InstructionsConfig | undefined {
        return this.getInstructionsConfig_();
    }

    /**
     * Explicitly invalidate compactionController's TTL cache. The `settings.write`
     * handler calls this per session (via workspace → sessionRegistry) after
     * writing compaction fields, so the next `effectiveCompaction()` reads disk.
     */
    invalidateCompactionCache(): void {
        this.compactionController.invalidate();
    }

    static async create(args: AttachedSessionOptions): Promise<AttachedSession> {
        if (!args.model) {
            throw new Error(
                "no model available for harness — please configure defaultModel or pass models",
            );
        }

        // Dynamic-tool assembly (before harness to avoid construction cycle).
        let toolController: SessionToolController | undefined;
        let initialTools = args.tools;
        if (args.toolRegistry) {
            const controller = new DefaultSessionToolController(args.toolRegistry);
            // The active-tool list lives in the lane's persisted configuration.
            // Read it straight off the session: the lane itself does not exist
            // until the harness is built, and the harness needs these tools in
            // its initial set.
            const storedConfig = await args.session.getValue(
                laneConfig(MAIN_BRANCH),
                harnessContext,
            );
            const restored = await controller.restoreTools(
                storedConfig?.value.activeToolNames ?? [],
            );

            // Always candidates are part of the session-start contract: failure is fatal.
            const alwaysCandidates = args.toolRegistry.listAlways();
            const alwaysTools = await Promise.all(alwaysCandidates.map((c) => c.load()));
            const alwaysToolMap = new Map(
                alwaysTools.map((t, i) => [alwaysCandidates[i].name, t] as [string, TacoTool]),
            );

            const addTools = createAddToolsTool(controller);
            initialTools = [...args.tools, addTools, ...restored, ...alwaysToolMap.values()];
            toolController = controller;
        }

        // `AgentHarness.create` restores suspended operations off the session,
        // so it is async and may report work that was interrupted mid-run by a
        // previous daemon exit.
        const { harness, open } = await AgentHarness.create<TacoToolContext>(
            {
                session: args.session,
                models: args.models,
                model: args.model,
                thinkingLevel: args.thinkingLevel ?? "off",
                systemPrompt: args.systemPrompt,
                tools: initialTools,
                resources: args.resources,
                streamOptions: await withTacoUserAgent(
                    args.streamOptions,
                    args.models,
                    args.model.provider,
                ),
                toolContext: args.getToolContext,
            },
            harnessContext,
        );

        if (open.length > 0) {
            // A run was in flight when the previous process was killed. pi
            // leaves it resumable rather than rolling it back, and a restored
            // operation still occupies `state.operation` — the same field
            // `lane.prompt()` rejects on with LaneBusy. Left undriven the
            // session is permanently unusable, so this is logged here and
            // resumed once the event/hook wiring is live (see
            // `resumeOpenOperations` at the end of create()).
            log.warn("session has interrupted operations from a previous run", {
                sessionId: args.session.metadata.id,
                count: open.length,
                operations: open,
            });
        }

        // One lane per session. `createAt: null` roots a fresh branch when the
        // session has no history; an existing branch is adopted as-is.
        const lane = await harness.lane(MAIN_BRANCH, { createAt: null }, harnessContext);

        // Bind the tool surface — controller constructed first, bound after:
        // breaks the cycle. Tool definitions live on the harness, the active
        // set on the lane, so the controller gets a facade over both.
        toolController?.bindHarness({
            getTools: () => harness.getTools(harnessContext),
            setTools: (tools) => harness.setTools([...tools], harnessContext),
            getActiveToolNames: () => lane.getActiveTools(harnessContext),
            setActiveToolNames: (names) => lane.setActiveTools([...names], harnessContext),
        });

        const branchEntries = await findBranchEntries(args.session);
        const pinOnceConsumer = new PinOnceConsumer(branchEntries);

        // ContextInfoService must be constructed first — CompactionController reuses
        // its getContextUsage path so the two do not each build context + estimateTokens.
        const contextInfo = new ContextInfoService({ session: args.session, lane });
        // Deferred reference — the controller is constructed before `attached`,
        // but its lifecycle sink must publish onto `attached`'s event stream.
        // Same deferred-evaluation pattern as the skill reinjector cell below.
        const attachedCell: { current: AttachedSession | undefined } = { current: undefined };
        const compactionController = new CompactionController({
            harness,
            lane,
            compaction: args.compaction,
            getContextUsage: () => contextInfo.getContextUsage(),
            pinOnceConsumer,
            getSessionEntries: () => findBranchEntries(args.session),
            getEntry: (id) => args.session.getEntry(id, harnessContext),
            // Publish the paired compaction lifecycle onto the same "event"
            // stream the harness feeds, so the push adapter's interlock sees a
            // guaranteed start/end pair. pi's own session_before_compact never
            // reaches subscribers (emitHook vs subscribe) — see the type doc.
            onLifecycle: (signal) =>
                attachedCell.current?.emit(
                    "event",
                    signal.phase === "start"
                        ? { type: COMPACTION_START_EVENT, tokensBefore: signal.tokensBefore }
                        : { type: COMPACTION_END_EVENT, reason: signal.reason },
                ),
        });

        // The `attached` reference must exist before wireHarnessHooks — the
        // getUiLocale / getCompactionThreshold thunks close over it.
        const attached = new AttachedSession(
            args.session,
            harness,
            lane,
            args.thinkingLevel ?? "off",
            args.defaultUiLocale,
            compactionController,
            contextInfo,
            toolController,
            args.getInstructionsConfig ?? (() => undefined),
            open,
            args.sessionKind,
        );
        attachedCell.current = attached;

        // Per-session task/plan state must be assigned before wireHarnessHooks —
        // hook thunks read attached.taskStore / planState / tasksDir at context build.
        attached.taskStore = args.taskStore;
        attached.planState = args.planState;
        attached.tasksDir = args.tasksDir;

        // Per-session manager over the workspace-shared store, so snapshots
        // carry the session that produced them. Must be assigned before
        // wireHarnessHooks — the mutation gate closes over it.
        attached.checkpoints = args.checkpointStore
            ? new CheckpointManager({
                  store: args.checkpointStore,
                  sessionId: args.session.metadata.id,
              })
            : undefined;

        // Register all hooks (protocol context + extension + debug) — see hookWiring.ts
        const { unsubscribe: unwireHooks, skillReinjector } = await wireHarnessHooks(
            harness,
            lane,
            {
                cwd: args.env.cwd,
                models: args.models,
                getThinkingLevel: () => attached.getThinkingLevel(),
                getUiLocale: () => attached.uiLocale,
                // Same source as maybeCompact: read the threshold from disk live so the
                // pin-aware hook can recompute keepRecentTokens.
                getCompactionThreshold: () => attached.effectiveCompaction().threshold,
                // Lazy accessor — the workspace holds the resolved InstructionsConfig
                // and re-reads `taco.json` on every settings.write, so the hook
                // picks up hot-reload without re-attaching the session.
                getInstructionsConfig: () => attached.getInstructionsConfig(),
                // Lazy accessor — yields undefined for non-IM workspaces; the
                // im_channel hook injects nothing there.
                getImChannelContext: args.getImChannelContext,
                extensionContextHooks: args.extensionContextHooks,
                extensionToolCallHooks: args.extensionToolCallHooks,
                extensionToolResultHooks: args.extensionToolResultHooks,
                skills: args.skills,
                memoryStore: args.memoryStore,
                getActiveTasksState: () => ({
                    store: attached.taskStore,
                    planActive: attached.planState.active,
                    planState: attached.planState,
                }),
                // Same root the tools resolve against — write/edit targets must stay
                // inside it, and plan mode refuses mutations at dispatch.
                mutationGateRoot: args.env.cwd,
                checkpointManager: attached.checkpoints,
                pinOnceConsumer,
            },
        );
        attached.skillReinjector = skillReinjector;

        // Build memory extractor: needs the session id (used as workspaceId for
        // project-scoped topic files).
        attached.memoryExtractor =
            args.memoryStore?.enabled && args.model && !args.isIm
                ? new MemoryExtractorImpl(
                      args.models,
                      args.model,
                      args.memoryStore,
                      args.session.metadata.id,
                  )
                : undefined;

        // pi 0.85 replaced the single `harness.subscribe(cb)` firehose with a
        // per-type bus. Republish every type the desktop consumes onto the
        // "event" stream, then attach the turn-boundary bookkeeping.
        const republish = (event: HarnessEvent): void => {
            try {
                attached.emit("event", event);
            } catch (error) {
                // A downstream listener that throws must not abort this callback:
                // the checkpoint window close, memory extraction, and compaction
                // bookkeeping below still have to run. One bad subscriber never
                // starves the turn-boundary work.
                log.warn("event listener threw; continuing turn-boundary bookkeeping", {
                    eventType: event.type,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const disposers: Array<() => void> = [];
        for (const type of REPUBLISHED_EVENTS) {
            disposers.push(harness.events.on(type, republish));
        }

        // Memory extraction — coordinator across two events:
        //   tool_end ("memory") → pushes a Promise<number> resolving to the
        //     context message count right after the commit.
        //   turn_end → takes ownership of all pending Promises (resets the
        //     array synchronously), then awaits their min offset. This handles
        //     multiple memory calls in the same turn — instead of overwriting,
        //     we take the earliest offset so only messages BEFORE all memory
        //     calls are sent to the extractor.
        disposers.push(
            harness.events.on("tool_end", (event) => {
                if (event.toolName !== "memory" || event.isError) return;
                // Push synchronously so turn_end's Promise.all sees it regardless of
                // microtask timing; the rejection is absorbed here (Infinity never wins
                // Math.min), so a context-build failure can't become an unhandled
                // rejection nor poison the offset computation.
                attached.lastRememberMessageCountPromises.push(
                    buildBranchContext(attached.session)
                        .then((messages) => messages.length)
                        .catch((error) => {
                            log.warn(
                                "context build failed during memory offset snapshot, skipping:",
                                error instanceof Error ? error.message : String(error),
                            );
                            return Number.POSITIVE_INFINITY;
                        }),
                );
            }),
        );

        disposers.push(
            harness.events.on("turn_end", () => {
                // Close the checkpoint window so the next turn's first write opens
                // a fresh restore point instead of folding into this turn's.
                attached.checkpoints?.endTurn();

                const extractor = attached.memoryExtractor;
                if (extractor === undefined) return;
                // Synchronous take + reset — after this line, no other code
                // path writes to lastRememberMessageCountPromises.
                const promises = attached.lastRememberMessageCountPromises;
                attached.lastRememberMessageCountPromises = [];
                buildBranchContext(attached.session)
                    .then(async (contextMessages) => {
                        let sinceCount: number | undefined;
                        if (promises.length > 0) {
                            try {
                                const counts = await Promise.all(promises);
                                sinceCount = Math.min(...counts);
                            } catch {
                                // extractor failure must never bleed into the
                                // turn — fall back to "no offset" semantics
                                sinceCount = undefined;
                            }
                        }
                        const messages = sliceForExtraction(contextMessages, sinceCount);
                        if (messages.length > 0) {
                            await extractor.onTurnEnd(messages);
                        }
                    })
                    .catch((error) => {
                        // The context build or the extractor rejecting must never
                        // surface as an unhandled rejection on this fire-and-forget chain.
                        log.warn(
                            "memory extraction after turn_end failed:",
                            error instanceof Error ? error.message : String(error),
                        );
                    });
            }),
        );

        // Auto-compaction scheduling + PinOnceConsumer updates.
        disposers.push(...compactionController.subscribe());

        attached.unsubscribe = () => {
            for (const dispose of disposers) dispose();
            unwireHooks();
        };

        // Deliberately last: resume drives a real run, which emits immediately.
        // Every subscriber, hook and the tool surface must already be wired or
        // the recovered turn's output is lost. Not awaited — a resumed run can
        // take as long as a normal turn, and attach must not block on it.
        if (open.length > 0) {
            attached.recovery = attached.resumeOpenOperations(open).finally(() => {
                attached.recovery = undefined;
            });
        }

        return attached;
    }

    /**
     * Drive operations that `AgentHarness.create()` reported as still open.
     *
     * Why this is not optional: a restored operation stays in the lane's
     * `state.operation`, and `lane.prompt()` rejects with `LaneBusy` whenever
     * that field is non-null. Ignoring `open[]` therefore does not leak a bit of
     * state — it leaves the session unable to accept another message, across
     * restarts, with no way for the user to clear it.
     *
     * `lane.resume()` re-enters the existing operation rather than starting a
     * new one, so the reply lands on the same branch the interrupted run was
     * building. Tool calls whose outcome was never recorded are replayed only
     * when the tool opts in with `replay: "safe"`; taco declares no such tool
     * (and neither does pi for bash/edit/write), so recovery cannot re-run a
     * side effect — the unfinished call is reported as interrupted instead.
     *
     * Failures are contained: this runs detached from `create()`, so throwing
     * would surface as an unhandled rejection and take down the daemon rather
     * than the session. A session that cannot be resumed is degraded, not
     * fatal — the user can still abort it explicitly.
     */
    /**
     * Block until crash recovery has released the lane. No-op in the normal
     * case — `recovery` is only set when `create()` found an open operation.
     *
     * Never rejects: `resumeOpenOperations` already contains its own failures,
     * and a caller waiting on recovery should proceed to its own `prompt()` (and
     * get that call's real error) rather than inherit a recovery failure.
     */
    private async awaitRecovery(): Promise<void> {
        await this.recovery?.catch(() => undefined);
    }

    private async resumeOpenOperations(open: ReadonlyArray<OpenOperation>): Promise<void> {
        const sessionId = this.session.metadata.id;
        // A lane holds at most one operation (`state.operation` is a single
        // slot), and `lane.resume()` takes no id — it resumes whatever its own
        // lane is holding. So only the entry for this session's lane is
        // actionable; anything else would resume the wrong lane. taco attaches
        // exactly one lane per session, so in practice this selects 0 or 1.
        const mine = open.find((operation) => operation.lane === MAIN_BRANCH);
        // Record every entry, including the ones this session cannot act on —
        // a post-mortem needs to see that they were seen and deliberately left.
        const skipped: RecoveryOutcome[] = open
            .filter((operation) => operation !== mine)
            .map((operation) => ({
                operationId: operation.operationId,
                lane: operation.lane,
                kind: operation.kind,
                status: "skipped" as const,
            }));
        if (mine === undefined) {
            this.recoveryOutcomes = skipped;
            log.warn("interrupted operations belong to other lanes; not resuming", {
                sessionId,
                lanes: open.map((operation) => operation.lane),
            });
            return;
        }

        // `aborting` means durable cancellation was requested before the crash.
        // Resuming still runs the operation to its terminal state, which is what
        // actually clears `state.operation` and frees the lane.
        const context = {
            sessionId,
            operationId: mine.operationId,
            kind: mine.kind,
            ...(mine.aborting === true ? { aborting: true } : {}),
        };
        const identity = { operationId: mine.operationId, lane: mine.lane, kind: mine.kind };
        const record = (outcome: RecoveryOutcome): void => {
            this.recoveryOutcomes = [...skipped, outcome];
        };
        try {
            const result = await this.lane.resume(harnessContext);
            if (!result.ok) {
                // NothingToResume is the benign race: the operation settled
                // between `create()` reporting it and this call.
                if (NothingToResume.is(result.error)) {
                    record({ ...identity, status: "already_settled" });
                    log.debug("interrupted operation already settled", context);
                    return;
                }
                record({ ...identity, status: "failed", error: result.error.message });
                log.warn("could not resume interrupted operation", {
                    ...context,
                    error: result.error.message,
                });
                return;
            }
            const status = "status" in result.value ? result.value.status : "suspended";
            record({ ...identity, status: "recovered", outcome: status });
            log.info("resumed interrupted operation", { ...context, status });
        } catch (error) {
            record({
                ...identity,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
            });
            log.error("resuming an interrupted operation threw", context, error);
        }
    }

    /**
     * Send one prompt — awaits the reply.
     *
     * pi 0.85 returns a `Result` carrying the operation record rather than the
     * reply itself, so the message is read back from the branch tip the run
     * landed on. The tip is normally an assistant message, but pi also allows
     * a run to close on a toolResult entry whose MessageEntry carries
     * `terminate: true` — that is how tools like askUser / planExit end a turn
     * ("ask the user and wait for the next prompt"). Returning the toolResult
     * message is correct: the protocol's `PromptResult.assistantMessage` is
     * typed as the wider `AgentMessage`, and the desktop's
     * `extractAssistantTextAndThinking` safely turns a non-assistant shape
     * into empty text. Throwing here would have caused session.prompt to fail
     * on a perfectly normal turn (the user-facing "expected an assistant
     * reply, got role=toolResult" error, plus a spurious session.delete that
     * removed a freshly-created session from the sidebar).
     *
     * A *non-assistant* tip without `terminate: true` still indicates a real
     * shape anomaly (an aborted-then-resumed run, an upstream invariant
     * change) and is left to fail loud — we don't want to silently downgrade
     * an internal bug into "nothing happened".
     */
    async prompt(
        text: string,
        images?: ImageContent[],
        uiLocale?: SupportedLocale,
    ): Promise<ProtocolAgentMessage> {
        if (uiLocale !== undefined) {
            this.uiLocale = uiLocale;
        }
        // A recovered operation occupies the lane until it settles, so prompting
        // during recovery would fail with LaneBusy — a spurious "session is
        // busy" on the first message after a crash. Wait it out instead.
        await this.awaitRecovery();
        const result = await this.lane.prompt(text, images, harnessContext);
        if (!result.ok) throw toHarnessError("session.prompt", result.error);

        if (result.value.status === "suspended") {
            // The run yielded without producing a terminal message (a deferred
            // provider call, or an abort landing between turns). There is no
            // reply to hand back.
            throw new Error(
                `session.prompt suspended without a reply (operationId=${result.value.operationId})`,
            );
        }

        // A run that reaches a terminal state resolves `ok: true` — reaching one
        // is not a call failure — so `status` has to be checked separately.
        // `record.error` is the only place the reason lives; without this the
        // failure surfaces as the "no reply" error below, which reports the
        // symptom and discards the cause (e.g. model_unavailable).
        if (result.value.status !== "completed") {
            throw toTerminalError("session.prompt", result.value);
        }

        const tipId = result.value.tipId;
        const entry =
            tipId === null ? undefined : await this.session.getEntry(tipId, harnessContext);
        const reply = entry?.type === "message" ? entry.message : undefined;

        if (resolvePromptReply(reply, entry) === "reject") {
            throw new Error(
                `session.prompt expected an assistant reply, got role=${String(
                    (reply as { role?: unknown } | undefined)?.role,
                )}`,
            );
        }
        // pi's message types carry provider-specific extras (`api`, `deferred`,
        // …) that the protocol models loosely, so a single assertion still
        // bridges the two. It is a plain cast, not a double one: the protocol's
        // `stopReason` now covers pi's whole `StopReason` union, so the two
        // shapes no longer structurally disagree.
        return reply as ProtocolAgentMessage;
    }

    /** Inject a steer message (mid-turn interrupt / append). */
    async steer(text: string, uiLocale?: SupportedLocale): Promise<void> {
        if (uiLocale !== undefined) {
            this.uiLocale = uiLocale;
        }
        const result = await this.lane.steer(text, undefined, harnessContext);
        if (!result.ok) throw toHarnessError("session.steer", result.error);
    }

    /** Effective UI locale — read by the reply_language hook on every context build. */
    getUiLocale(): SupportedLocale | undefined {
        return this.uiLocale ?? this.defaultUiLocale;
    }

    /** Switch model (persisted to the session). */
    async setModel(model: Model<Api>): Promise<void> {
        // pi 0.85 takes a ModelIdentity (provider + id) rather than the full
        // model record, and resolves it against the harness's Models registry.
        await this.lane.setModel({ provider: model.provider, modelId: model.id }, harnessContext);
    }

    /**
     * Switch thinking level at runtime. Emits a `config_update` event, which
     * flows back to clients via session.event.
     */
    async setThinkingLevel(level: ThinkingLevel): Promise<void> {
        await this.lane.setThinkingLevel(level, harnessContext);
        this.thinkingLevel = level;
    }

    /**
     * Current thinking level.
     *
     * Served from a cached copy rather than the lane: pi 0.85 made the lane
     * getter async, but the strip-thinking context hook runs synchronously on
     * every LLM call. The cache is seeded at attach and updated by
     * `setThinkingLevel`, which is the only way it changes.
     */
    getThinkingLevel(): ThinkingLevel {
        return this.thinkingLevel;
    }

    /**
     * Abort the current turn.
     *
     * "Nothing is running" is a normal outcome, not a failure: callers abort
     * defensively (session.abort RPC, subagent teardown, dispose) without
     * knowing whether a turn is in flight. pi 0.85 reports it as a
     * `NoActiveOperation` result, so it maps to "nothing cleared" rather than
     * a throw.
     */
    async abort(): Promise<AbortResult> {
        const result = await this.lane.abort(harnessContext);
        if (!result.ok) {
            if (NoActiveOperation.is(result.error)) {
                return { clearedSteer: [], clearedFollowUp: [] };
            }
            throw toHarnessError("session.abort", result.error);
        }
        return {
            clearedSteer: result.value.steer,
            clearedFollowUp: result.value.followUp,
        };
    }

    // ─────────── compaction / context queries (delegated) ───────────

    /** Manually trigger compaction. Delegates to CompactionController. */
    async compact(
        customInstructions?: string,
        signal?: AbortSignal,
    ): Promise<SessionCompactResult> {
        return await this.compactionController.compact(customInstructions, signal);
    }

    /** Fetch current session context info. Delegates to ContextInfoService. */
    async getContextInfo(): Promise<SessionContextInfoResult> {
        return await this.contextInfo.getContextInfo();
    }

    async dispose(): Promise<void> {
        try {
            // Returns Result.err(NoActiveOperation) when already idle, which is
            // the common case on a clean detach — not worth branching on.
            await this.lane.abort(harnessContext);
        } catch (error) {
            log.debug(
                "abort during dispose failed:",
                error instanceof Error ? error.message : String(error),
            );
        }
        if (this.unsubscribe) this.unsubscribe();
        try {
            // Releases the hook/event registries and seals the lane so late
            // callbacks reject instead of touching a torn-down session.
            await this.harness.close(harnessContext);
        } catch (error) {
            log.debug(
                "harness close during dispose failed:",
                error instanceof Error ? error.message : String(error),
            );
        }
        this.removeAllListeners();
    }
}
