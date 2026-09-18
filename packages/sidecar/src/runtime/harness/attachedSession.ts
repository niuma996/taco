/**
 * AttachedSession — binds one session to an AgentHarness.
 * Forwards harness events/errors as "event"/"error", wraps prompt / steer /
 * abort / setModel, delegates compaction to CompactionController and context
 * usage to ContextInfoService. Hook wiring lives in `./hookWiring.ts`,
 * harness-event wiring + per-turn bookkeeping in `./turnBookkeeping.ts`,
 * crash recovery in `../session/sessionRecovery.ts`, toolset convergence in
 * `./toolsetRefresh.ts`; reply validation / request tagging live in
 * `./promptReply.ts` and `../models/requestHeaders.ts`.
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
import { asSessionId } from "@taco-ai/protocol";
import { CheckpointManager } from "../../checkpoints/manager.ts";
import type { CheckpointStore } from "../../checkpoints/store.ts";
import type { ResolvedCompaction } from "../../config/config.ts";
import type {
    ContextHookBuckets,
    ToolCallHook,
    ToolResultHookBuckets,
} from "../../extensions/index.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import { MemoryExtractorImpl, type MemoryStore } from "../../memory/index.ts";
import type { PlanModeState } from "../../plan/planModeState.ts";
import type { SkillReinjectorHandle } from "../../skills/skillReinjector.ts";
import type { TacoSkill } from "../../skills/tacoSkill.ts";
import type { ImChannelContext } from "../../tags/index.ts";
import type { TaskStore } from "../../tasks/taskTypes.ts";
import { createAddToolsTool } from "../../tools/addTools.ts";
import type { TacoToolContext } from "../../tools/context.ts";
import type { TacoTool } from "../../tools/index.ts";
import {
    COMPACTION_END_EVENT,
    COMPACTION_START_EVENT,
    CompactionController,
} from "../compaction/compactionController.ts";
import { ContextInfoService } from "../compaction/contextInfoService.ts";
import { PinOnceConsumer } from "../compaction/pinOnceConsumer.ts";
import { withTacoUserAgent } from "../models/requestHeaders.ts";
import type { NodeExecutionEnv } from "../pi/node.ts";
import type {
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    AgentLane,
    AgentMessage,
    Api,
    ImageContent,
    Model,
    Models,
    OpenOperation,
    PromptTemplate,
    Session,
    ThinkingLevel,
} from "../pi/types.ts";
import { AgentHarness, laneConfig, NoActiveOperation } from "../pi/values.ts";
import { findBranchEntries, MAIN_BRANCH } from "../session/sessionBranch.ts";
import { type RecoveryOutcome, resumeOpenOperations } from "../session/sessionRecovery.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import { toHarnessError, toTerminalError } from "./harnessErrors.ts";
import { wireHarnessHooks } from "./hookWiring.ts";
import {
    type CancelQueuedKind,
    cancelLaneQueued,
    enqueueLaneMessage,
    type QueueKind,
    type SteerEnqueueResult,
} from "./laneQueue.ts";
import { resolvePromptReply } from "./promptReply.ts";
import {
    DefaultSessionToolController,
    type SessionToolController,
} from "./sessionToolController.ts";
import { createToolsetRefresher } from "./toolsetRefresh.ts";
import { wireTurnBookkeeping } from "./turnBookkeeping.ts";

const log = createLogger("attachedSession");

export interface AbortResult {
    clearedSteer: AgentMessage[];
    clearedFollowUp: AgentMessage[];
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
    /**
     * Thunk over the loaded skill list — forwarded to the skill body
     * reinjector hook. See `HookWiringOptions.getSkills` for why this must
     * stay a thunk rather than a captured array.
     */
    getSkills?: () => readonly TacoSkill[];
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
     * Re-assemble the workspace toolset for this session, returning it only when
     * it differs from what the workspace last handed out (undefined = unchanged,
     * the steady state). Called at the start of each turn so a permission change
     * reaches an existing conversation on its next message.
     *
     * Returns the system prompt alongside the tools because the two must move
     * together: offering a tool the prompt says you lack — or the reverse —
     * is worse than either being stale. `removed` names the workspace tools the
     * change retired; the session layer keeps everything else it had installed.
     */
    refreshToolset?: () =>
        | { tools: TacoTool[]; removed: string[]; systemPrompt: string }
        | undefined;
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
    /** Converges the toolset + system prompt at the start of a turn; no-op when
     *  the workspace supplied no refresher (subagents, tests). */
    private applyToolsetRefresh?: () => Promise<void>;
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

        // Mutable so the per-turn refresh can swap in a rebuilt prompt; read
        // through the thunk handed to AgentHarness below.
        let currentSystemPrompt = args.systemPrompt;

        // `AgentHarness.create` restores suspended operations off the session,
        // so it is async and may report work that was interrupted mid-run by a
        // previous daemon exit.
        const { harness, open } = await AgentHarness.create<TacoToolContext>(
            {
                session: args.session,
                models: args.models,
                model: args.model,
                thinkingLevel: args.thinkingLevel ?? "off",
                // A thunk, not the string: pi calls it while assembling each
                // request, so a prompt rebuilt by refreshToolset (below) is
                // picked up without having to mutate harness state. Falls back
                // to the attach-time value when no refresher is wired.
                systemPrompt: () => currentSystemPrompt,
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
            // guaranteed start/end pair. The end signal carries `committed` —
            // that, not a `session_compact` event, is how the push layer learns
            // the compaction succeeded. pi 0.85 has no such event.
            onLifecycle: (signal) =>
                attachedCell.current?.emit(
                    "event",
                    signal.phase === "start"
                        ? { type: COMPACTION_START_EVENT, tokensBefore: signal.tokensBefore }
                        : {
                              type: COMPACTION_END_EVENT,
                              reason: signal.reason,
                              committed: signal.committed,
                          },
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
        // Per-turn toolset convergence. Assigned here rather than threaded
        // through the constructor (already 11 params); the refresher also owns
        // the prompt cell so the two can only move together.
        if (args.refreshToolset) {
            attached.applyToolsetRefresh = createToolsetRefresher({
                harness,
                lane,
                refresh: args.refreshToolset,
                setSystemPrompt: (prompt) => {
                    currentSystemPrompt = prompt;
                },
            });
        }

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
                getSkills: args.getSkills,
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

        // Republish the harness events the desktop consumes, plus per-turn
        // bookkeeping (checkpoint window close, incremental memory extraction).
        const disposers = wireTurnBookkeeping({
            harness,
            session: args.session,
            emitEvent: (event) => attached.emit("event", event),
            getCheckpoints: () => attached.checkpoints,
            getExtractor: () => attached.memoryExtractor,
        });

        // Push the derived settings onto pi before any run can start, so the
        // first turn-boundary check already uses the user's threshold rather
        // than pi's defaults. Awaited: a resumed run below may compact.
        await compactionController.syncSettings();

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
            attached.recovery = resumeOpenOperations({
                lane,
                sessionId: asSessionId(args.session.metadata.id),
                open,
            })
                .then((outcomes) => {
                    attached.recoveryOutcomes = outcomes;
                })
                .finally(() => {
                    attached.recovery = undefined;
                });
        }

        return attached;
    }

    /**
     * Block until crash recovery has released the lane. No-op in the normal
     * case — `recovery` is only set when `create()` found an open operation.
     *
     * Never rejects: `sessionRecovery.resumeOpenOperations` already contains its own
     * failures, and a caller waiting on recovery should proceed to its own
     * `prompt()` (and get that call's real error) rather than inherit a recovery
     * failure.
     */
    private async awaitRecovery(): Promise<void> {
        await this.recovery?.catch(() => undefined);
    }

    /**
     * Send a prompt and read its reply from the branch tip identified by pi's
     * operation result. A terminating toolResult (askUser / planExit) is a valid
     * reply: the protocol accepts AgentMessage and the desktop handles it.
     * Non-assistant tips without `terminate: true` remain invariant violations.
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
        // Converge before the run reads the toolset: a permission granted or
        // revoked since the last message takes effect on this turn.
        await this.applyToolsetRefresh?.();
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

    /**
     * Enqueue a message onto one of the lane's steering queues: `steer` is
     * consumed at the next tool-batch checkpoint (interrupt and redirect),
     * `followUp` only once the run would otherwise finish (queue behind it).
     */
    async enqueue(
        kind: QueueKind,
        text: string,
        images?: ImageContent[],
        uiLocale?: SupportedLocale,
    ): Promise<SteerEnqueueResult> {
        if (uiLocale !== undefined) {
            this.uiLocale = uiLocale;
        }
        return await enqueueLaneMessage(this.lane, kind, text, images);
    }

    /** Remove one not-yet-consumed queue entry. "already_consumed" / "not_found" are normal outcomes. */
    async cancelQueued(entryId: string): Promise<CancelQueuedKind> {
        return await cancelLaneQueued(this.lane, entryId);
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
        // The trigger and retention are both fractions of the model window, so
        // a model switch must re-derive them or the session keeps compacting
        // against the previous model's window.
        await this.compactionController.syncSettings();
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
