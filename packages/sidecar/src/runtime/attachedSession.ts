/**
 * AttachedSession — binds one session to an AgentHarness.
 * Forwards harness events/errors as "event"/"error", wraps prompt / steer /
 * abort / setModel, delegates compaction to CompactionController and context
 * usage to ContextInfoService. Hook wiring lives in `./hookWiring.ts`.
 * dispose() aborts the harness and releases all listeners/subscriptions.
 */

import { EventEmitter } from "node:events";
import {
    AgentHarness,
    type AgentHarnessEvent,
    type AgentHarnessResources,
    type AgentHarnessStreamOptions,
    type AgentMessage,
    type PromptTemplate,
    type Session,
    type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import type {
    InstructionsConfig,
    AssistantMessage as ProtocolAssistantMessage,
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
import { createLogger } from "../lib/logger.ts";
import { MemoryExtractorImpl, type MemoryStore, sliceForExtraction } from "../memory/index.ts";
import type { SkillReinjectorHandle } from "../skills/skillReinjector.ts";
import type { TacoSkill } from "../skills/tacoSkill.ts";
import type { ImChannelContext } from "../tags/index.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";
import { createAddToolsTool } from "../tools/addTools.ts";
import type { TacoToolContext } from "../tools/context.ts";
import type { TacoTool } from "../tools/index.ts";
import type { PlanModeState } from "../tools/planModeState.ts";
import {
    COMPACTION_END_EVENT,
    COMPACTION_START_EVENT,
    CompactionController,
} from "./compactionController.ts";
import { ContextInfoService } from "./contextInfoService.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import { wireHarnessHooks } from "./hookWiring.ts";
import { PinOnceConsumer } from "./pinOnceConsumer.ts";
import { sidecarVersion } from "./runtimeResources.ts";
import {
    DefaultSessionToolController,
    type SessionToolController,
} from "./sessionToolController.ts";

const log = createLogger("attachedSession");

export interface AbortResult {
    clearedSteer: AgentMessage[];
    clearedFollowUp: AgentMessage[];
}

/**
 * Tag provider requests with the sidecar version.
 *
 * `user-agent: taco/<version>` — set on every NON-OAuth provider. OAuth
 * providers (Anthropic OAuth in particular) need their
 * `claude-cli/<version>` identity preserved, and pi-ai's openai / anthropic
 * SDKs read `this.constructor.name` for the default UA — overriding that
 * with `taco/<version>` would lose Claude Code's OAuth beta features. The
 * OAuth check uses `checkAuth` rather than `getAuth` because the former
 * never triggers a token refresh.
 *
 * `x-taco-sidecar-version: <version>` — set on EVERY provider, OAuth or
 * not. It's metadata (which taco build made the call), not identity, so
 * it never conflicts with the OAuth UA. On an OAuth call it is the only
 * taco tag that survives, which is enough to attribute the request to a
 * taco version in the provider's access logs.
 *
 * If `checkAuth` cannot classify the provider (returns undefined or
 * throws), we skip the `user-agent` override but still attach the
 * version header — the version is safe; the UA is the identity-bearing
 * field.
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
}

export class AttachedSession extends EventEmitter {
    readonly session: Session;
    private readonly harness: AgentHarness<TacoToolContext>;
    private uiLocale: SupportedLocale | undefined;
    private readonly defaultUiLocale: SupportedLocale | undefined;
    private unsubscribe?: () => void;
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
     * `tool_execution_end("memory")` stores a Promise; `turn_end` chains off
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
        defaultUiLocale: SupportedLocale | undefined,
        compactionController: CompactionController,
        contextInfo: ContextInfoService,
        toolController: SessionToolController | undefined,
        getInstructionsConfig: () => InstructionsConfig | undefined,
    ) {
        super();
        this.session = session;
        this.harness = harness;
        this.defaultUiLocale = defaultUiLocale;
        this.compactionController = compactionController;
        this.contextInfo = contextInfo;
        this.toolController = toolController;
        this.getInstructionsConfig_ = getInstructionsConfig;
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
            const restored = await controller.restoreTools(args.session);

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

        const harness = new AgentHarness<TacoToolContext>({
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
        });

        // Bind harness reference — controller constructed first, bound after: breaks the cycle.
        toolController?.bindHarness(harness);

        const branchEntries = await args.session.getBranch();
        const pinOnceConsumer = new PinOnceConsumer(branchEntries);

        // ContextInfoService must be constructed first — CompactionController reuses
        // its getContextUsage path so the two do not each buildContext + estimateTokens.
        const contextInfo = new ContextInfoService({ session: args.session, harness });
        // Deferred reference — the controller is constructed before `attached`,
        // but its lifecycle sink must publish onto `attached`'s event stream.
        // Same deferred-evaluation pattern as the skill reinjector cell below.
        const attachedCell: { current: AttachedSession | undefined } = { current: undefined };
        const compactionController = new CompactionController({
            harness,
            compaction: args.compaction,
            getContextUsage: () => contextInfo.getContextUsage(),
            pinOnceConsumer,
            getSessionEntries: () => args.session.getBranch(),
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
            args.defaultUiLocale,
            compactionController,
            contextInfo,
            toolController,
            args.getInstructionsConfig ?? (() => undefined),
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
        const sessionMeta = await args.session.getMetadata();
        attached.checkpoints = args.checkpointStore
            ? new CheckpointManager({
                  store: args.checkpointStore,
                  sessionId: sessionMeta.id,
              })
            : undefined;

        // Register all hooks (protocol context + extension + debug) — see hookWiring.ts
        const { unsubscribe: unwireHooks, skillReinjector } = await wireHarnessHooks(harness, {
            cwd: args.env.cwd,
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
        });
        attached.skillReinjector = skillReinjector;

        // Build memory extractor: needs the session id (used as workspaceId for
        // project-scoped topic files). `sessionMeta` was already fetched above
        // for the checkpoint manager.
        attached.memoryExtractor =
            args.memoryStore?.enabled && args.model && !args.isIm
                ? new MemoryExtractorImpl(
                      harness.models,
                      args.model,
                      args.memoryStore,
                      sessionMeta.id,
                  )
                : undefined;

        // harness AgentEvent → AttachedSession "event"
        const unsubEvent = harness.subscribe((event: AgentHarnessEvent) => {
            attached.emit("event", event);

            // Memory extraction — coordinator: same callback handles
            //   tool_execution_end ("memory") → pushes a Promise<number>
            //     resolving to ctx.messages.length right after the commit.
            //   turn_end → takes ownership of all pending Promises (resets
            //     array synchronously), then awaits their min offset. This
            //     handles multiple memory calls in the same turn — instead of
            //     overwriting, we take the earliest offset so only messages
            //     BEFORE all memory calls are sent to the extractor.
            if (
                event.type === "tool_execution_end" &&
                event.toolName === "memory" &&
                !event.isError
            ) {
                // Push synchronously so turn_end's Promise.all sees it regardless of
                // microtask timing; the rejection is absorbed here (Infinity never wins
                // Math.min), so a buildContext failure can't become an unhandled
                // rejection nor poison the offset computation.
                attached.lastRememberMessageCountPromises.push(
                    attached.session
                        .buildContext()
                        .then((ctx) => ctx.messages.length)
                        .catch((error) => {
                            log.warn(
                                "buildContext failed during memory offset snapshot, skipping:",
                                error instanceof Error ? error.message : String(error),
                            );
                            return Number.POSITIVE_INFINITY;
                        }),
                );
            }

            // Close the checkpoint window so the next turn's first write opens a
            // fresh restore point instead of folding into this turn's.
            if (event.type === "turn_end") {
                attached.checkpoints?.endTurn();
            }

            if (event.type === "turn_end" && attached.memoryExtractor) {
                const extractor = attached.memoryExtractor;
                // Synchronous take + reset — after this line, no other code
                // path writes to lastRememberMessageCountPromises.
                const promises = attached.lastRememberMessageCountPromises;
                attached.lastRememberMessageCountPromises = [];
                attached.session
                    .buildContext()
                    .then(async (ctx) => {
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
                        const messages = sliceForExtraction(ctx.messages, sinceCount);
                        if (messages.length > 0) {
                            await extractor.onTurnEnd(messages);
                        }
                    })
                    .catch((error) => {
                        // buildContext() or the extractor rejecting must never
                        // surface as an unhandled rejection on this fire-and-forget chain.
                        log.warn(
                            "memory extraction after turn_end failed:",
                            error instanceof Error ? error.message : String(error),
                        );
                    });
            }

            // Delegate to compactionController: auto-compaction scheduling +
            // PinOnceConsumer updates.
            compactionController.onHarnessEvent(event);
        });

        attached.unsubscribe = () => {
            unsubEvent();
            unwireHooks();
        };

        return attached;
    }

    /**
     * Send one prompt — awaits the reply. The turn's final message is the
     * assistant reply by construction (pi runs until stop/aborted/error), so we
     * narrow pi's wider AgentMessage union to the protocol AssistantMessage
     * here rather than pushing an unsafe cast onto every consumer.
     */
    async prompt(
        text: string,
        images?: ImageContent[],
        uiLocale?: SupportedLocale,
    ): Promise<ProtocolAssistantMessage> {
        if (uiLocale !== undefined) {
            this.uiLocale = uiLocale;
        }
        const reply = await this.harness.prompt(text, images ? { images } : undefined);
        // pi's AgentMessage union is wider than the protocol AssistantMessage.
        // The turn's terminal message is the assistant reply by construction,
        // but an abort/early-error path could surface a non-assistant shape —
        // fail loud here so a shape change never silently corrupts consumers.
        if (reply.role !== "assistant") {
            throw new Error(
                `session.prompt expected an assistant reply, got role=${String((reply as { role?: unknown }).role)}`,
            );
        }
        return reply as ProtocolAssistantMessage;
    }

    /** Inject a steer message (mid-turn interrupt / append). */
    async steer(text: string, uiLocale?: SupportedLocale): Promise<void> {
        if (uiLocale !== undefined) {
            this.uiLocale = uiLocale;
        }
        await this.harness.steer(text);
    }

    /** Effective UI locale — read by the reply_language hook on every context build. */
    getUiLocale(): SupportedLocale | undefined {
        return this.uiLocale ?? this.defaultUiLocale;
    }

    /** Switch model (persisted to the session). */
    async setModel(model: Model<Api>): Promise<void> {
        await this.harness.setModel(model);
    }

    /** Switch thinking level at runtime; the harness emits ThinkingLevelUpdateEvent, which flows back to clients via session.event. */
    async setThinkingLevel(level: ThinkingLevel): Promise<void> {
        await this.harness.setThinkingLevel(level);
    }

    /** Current harness thinking level. */
    getThinkingLevel(): ThinkingLevel {
        return this.harness.getThinkingLevel();
    }

    /** Abort the current turn. */
    async abort(): Promise<AbortResult> {
        return await this.harness.abort();
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
            await this.harness.abort();
        } catch {
            // may already be idle — ignore
        }
        if (this.unsubscribe) this.unsubscribe();
        this.removeAllListeners();
    }
}
