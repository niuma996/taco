/**
 * AgentSpawner — subagent creation and execution: validates the agentType,
 * narrows the toolset, then drives the child to completion.
 *
 * The child's attach assembly lives in `./childAttach.ts`, its run loop in
 * `./subagentRunner.ts`, and the parent-depth read in `../session/sessionFacts.ts`.
 */

import { EventEmitter } from "node:events";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import {
    type AgentToolPolicy,
    agentToolPolicy,
    filterToolsForAgent,
} from "../../agents/filterTools.ts";
import { buildForkedContext, resolveContextMode } from "../../agents/forkedHistory.ts";
import { MAX_AGENT_TURNS } from "../../agents/loadAgents.ts";
import type {
    AgentDefinition,
    AgentFewShot,
    ClaudeCodePermissionMode,
    CodexAgentConfig,
    SubagentContextMode,
    SubagentProgressSink,
    SubagentRuntime,
} from "../../agents/types.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { SystemPromptContributor } from "../../prompts/buildSystemPrompt.ts";
import type { DeferredToolCatalogEntry } from "../../prompts/formatCatalogForSystemPrompt.ts";
import type { EnvironmentContext } from "../../prompts/index.ts";
import { interpolateArgs } from "../../skills/skillMessages.ts";
import type { SpawnSkillSubagentOptions } from "../../skills/skillTool.ts";
import { writeTextAtomic } from "../../store/atomicFile.ts";
import { tagWrap } from "../../tags/builder.ts";
import type { SubagentBudgetState } from "../../tags/subagentBudget.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { BackgroundWorkHooks } from "../../work/workHooks.ts";
import type { WorkAttemptHandle } from "../../work/workOperationTypes.ts";
import type { AttachedSession } from "../harness/attachedSession.ts";
import { findModelById } from "../models/modelLookup.ts";
import { scrubbedProcessEnv } from "../models/providerKeyStore.ts";
import type { NodeExecutionEnv } from "../pi/node.ts";
import type { AgentMessage, Api, Model, MutableModels } from "../pi/types.ts";
import { uuidv7 } from "../pi/values.ts";
import { findBranchEntries, MAIN_BRANCH } from "../session/sessionBranch.ts";
import {
    readSessionFacts,
    resolveParentDepth,
    writeSessionFacts,
} from "../session/sessionFacts.ts";
import type { AttachOptions, SessionRegistry } from "../session/sessionRegistry.ts";
import { type AgentMessageRecord, agentMessageEnvelope } from "./agentConversation.ts";
import { AgentConversationRuntime } from "./agentConversationRuntime.ts";
import { type ChildAttachDeps, prepareChildAttach } from "./childAttach.ts";
import { runClaudeCodeSubagent } from "./claudeCode/claudeCodeRunner.ts";
import { findClaudeExecutable, loadClaudeAgentSdk } from "./claudeCode/claudeCodeSdk.ts";
import { readClaudeCodeState, writeClaudeCodeState } from "./claudeCode/claudeCodeState.ts";
import {
    type CodexCommunicationBridge,
    createCodexCommunicationBridge,
} from "./codex/codexCommunication.ts";
import { runCodexSubagent } from "./codex/codexRunner.ts";
import { codexRuntimeUnavailableMessage } from "./codex/codexRuntimeInstall.ts";
import {
    CODEX_SDK_VERSION,
    createCodexClient,
    type LoadedCodexSdk,
    loadCodexSdk,
} from "./codex/codexSdk.ts";
import {
    type CodexState,
    codexProfileIdentity,
    readCodexState,
    writeCodexState,
} from "./codex/codexState.ts";
import { deliverSubagentResult, deliverSubagentResultDetailed } from "./subagentDelivery.ts";
import {
    addPendingSubagentResult,
    clearPendingSubagentResult,
    readPendingSubagentResults,
} from "./subagentPending.ts";
import type { SubagentResumability } from "./subagentProgress.ts";
import { subagentResultPath } from "./subagentResultsDir.ts";
import { type ResumeSubagentArgs, runSubagentResume } from "./subagentResume.ts";
import { runAttachedSubagent, type SubagentRunResult } from "./subagentRunner.ts";

const log = createLogger("sidecar.agentSpawner");

/**
 * Global cap on concurrently-running `background: true` spawns, across every
 * parent session in this workspace. Synchronous spawns are not counted — a
 * synchronous child is already bounded by its parent turn's lifetime, so it
 * cannot accumulate the way an unbounded set of background runs could.
 */
const MAX_CONCURRENT_BACKGROUND_SUBAGENTS = 8;

/**
 * Wall-clock allowance per turn, used to derive a background run's time budget
 * from its turn budget.
 *
 * The two limits have to agree, or one of them silently governs: a run with a
 * 100-turn budget that is cut off after 10 minutes never reaches the turns it
 * was allowed, and the work it did is thrown away with the timeout. A turn
 * that legitimately needs more than this is rare — a model round trip plus a
 * tool call is seconds — and a turn stuck on a slow command is exactly what
 * the timeout exists to catch.
 */
const BACKGROUND_TURN_ALLOWANCE_MS = 30_000;

/** Shortest budget a background run gets, whatever its turn budget says. */
const MIN_BACKGROUND_TIMEOUT_MS = 10 * 60_000;

/**
 * Longest budget a background run gets, derived from the largest allowed turn
 * budget so that no permitted turn budget is cut short by the wall clock. A
 * run that reaches it is stuck, not slow.
 */
const MAX_BACKGROUND_TIMEOUT_MS = MAX_AGENT_TURNS * BACKGROUND_TURN_ALLOWANCE_MS;

/**
 * Turn budget assumed when a profile sets none. The pi runtime leaves such a
 * run unbounded in turns, so the wall clock is its only bound and this decides
 * how long that bound is.
 */
const ASSUMED_TURNS_WITHOUT_CAP = 100;

/**
 * The wall-clock budget for a `background: true` spawn whose profile sets no
 * `timeoutMinutes`.
 *
 * Derived from the turn budget so the turn cap is the limit the person who
 * wrote the profile actually chose, and the timeout only catches a run that
 * is stuck rather than one that is still working.
 */
export function backgroundTimeoutMs(maxTurns: number | undefined): number {
    const turns = maxTurns !== undefined && maxTurns > 0 ? maxTurns : ASSUMED_TURNS_WITHOUT_CAP;
    const derived = turns * BACKGROUND_TURN_ALLOWANCE_MS;
    return Math.min(MAX_BACKGROUND_TIMEOUT_MS, Math.max(MIN_BACKGROUND_TIMEOUT_MS, derived));
}

export interface AgentSpawnerOptions {
    readonly cwd: WorkspaceId;
    /** Stable routing key; unlike cwd this remains im://... for channel workspaces. */
    readonly workspaceKey?: WorkspaceId;
    /**
     * Same root `JsonlSessionRepo` writes to. Background subagent results are
     * written under it (`subagentResultsDir`), so a relative value would scatter
     * them under the process cwd instead of beside the sessions.
     */
    readonly sessionsRoot: string;
    /** Workspace/associated roots a Codex cwd may resolve into. */
    readonly getAllowedCwds?: () => readonly string[];
    readonly env: NodeExecutionEnv;
    readonly models: MutableModels;
    /**
     * Parent session toolset — `filterToolsForAgent` further restricts by agent
     * whitelist / depth. A thunk, not a value: `WorkspaceRuntime.refreshToolset`
     * replaces the workspace's tool array per turn (IM policy grants, extension
     * changes), and a captured array would spawn every subsequent subagent
     * against whatever toolset existed when the workspace was constructed.
     */
    readonly getTools: () => TacoTool[];
    /** Subagent definition registry; `spawnSubagent` looks up by `agentType`. */
    readonly agents: AgentDefinition[];
    /** SessionRegistry reference — used to call createSession / attachChild / openSession / invalidateListCache. */
    readonly sessionRegistry: SessionRegistry;
    /**
     * Contributors used to build the workspace system prompt. Re-applied when
     * rebuilding a subagent's system prompt from its restricted toolset so
     * user-defined rules and extension contributions are preserved.
     */
    readonly systemPromptContributors?: SystemPromptContributor[];
    /**
     * Parent workspace's default model. Used as the identity string in
     * rebuilt subagent prompts unless the caller passes an explicit
     * `args.model` for this specific spawn.
     */
    readonly defaultModel?: Model<Api>;
    /**
     * Pre-rendered `<project_context>` block (workspace-level, shared by
     * every child). Pass-through to rebuilt subagent prompts so the denylist
     * stays consistent across parent and children.
     */
    readonly projectContext?: string;
    /**
     * Workspace-level `<environment>` snapshot (cwd/platform/shell/git), passed
     * through to rebuilt subagent prompts. Without it a child in a workspace
     * with no `.gitignore` would get no `<project_context>` cwd line and no
     * environment block at all — no cwd, platform, or shell.
     */
    readonly environmentContext?: EnvironmentContext;
    /**
     * Mirrors the parent's IM/third-party channel flag. Children inherit it so
     * their rebuilt prompt carries the same `<channel_safety>` block and the
     * path-semantics variant that omits absolute-path examples — a child that
     * missed it would relay full filesystem paths back through the channel.
     */
    readonly hideWorkspacePath?: boolean;
    /**
     * Reads the parent's rendered instruction blocks (CLAUDE.md / AGENTS.md /
     * DESIGN.md), appended as an `<instructions>` section to every child's
     * rebuilt system prompt so the parent's project rules apply in the child
     * session too. Returns "" when inheritance is disabled or no files resolved.
     *
     * A thunk, not a string: `WorkspaceRuntime.updateInstructionsConfig()`
     * re-renders the block on `settings.write`, and a value captured at
     * construction would pin children to the startup config for the process's
     * lifetime while the parent picked up the change. Same reason
     * `SessionRegistry` takes `getInstructionsConfig`.
     */
    readonly getParentInstructionsBlock?: () => string;
    /**
     * Deferred tools the workspace can load on demand, unfiltered. A child
     * prompt narrows this by the agent's declared tools, so the
     * `<deferred_tools>` listing matches what its `addTools` will accept.
     */
    readonly getDeferredToolCatalog?: () => readonly DeferredToolCatalogEntry[];
    /**
     * Work-layer hooks for background spawns. Absent in tests and in any
     * assembly that does not track Work; every call site is optional-chained so
     * the spawner behaves exactly as before without it.
     */
    readonly workHooks?: BackgroundWorkHooks;
}

/** Arguments for one subagent run. Shared by `executeSubagentSession` and its body. */
export interface SubagentSessionArgs {
    parentSessionId: SessionId;
    parentToolCallId: string;
    /** Metadata agentType + event agentType (must be consistent). */
    agentType: string;
    /** Prompt text sent to the child harness. */
    prompt: string;
    /** Pre-filtered toolset (caller handles whitelist + Skill removal). */
    tools: TacoTool[];
    model?: Model<Api>;
    signal?: AbortSignal;
    /**
     * Controller behind `signal`, registered under the child session id while
     * the run executes so `abortSubagentRun` can stop this child alone.
     * Callers that only pass `signal` get no external-stop handle.
     */
    abortController?: AbortController;
    /**
     * Profile body from the agent definition's markdown, appended to the
     * child's system prompt so the role, stop condition and reporting
     * contract actually reach the model. Skill subagents pass nothing —
     * their instructions are the prompt itself.
     */
    rolePrompt?: string;
    /**
     * `claude-code` only: the definition's raw tool names (Claude Code's own,
     * so `tools` — taco tool objects filtered by those names — cannot carry
     * them) and its permission mode.
     */
    claudeCodeTools?: readonly string[];
    permissionMode?: ClaudeCodePermissionMode;
    /** `claude-code` only: the definition's fixed directory. Absent = the execution cwd. */
    claudeCodeCwd?: string;
    /** `codex` only: SDK thread options from the definition's `codex:` block. */
    codexConfig?: CodexAgentConfig;
    /** `codex` only: profile tool names used to grant the communication bridge. */
    codexTools?: readonly string[];
    /**
     * Optional in-context examples to inject ahead of `rolePrompt`. The
     * examples establish the contract the profile expects (e.g. citation
     * shape, stop condition) before the role body takes over. Kept
     * outside `SystemPromptContributor` because they are profile-specific
     * rather than workspace-wide.
     */
    fewShots?: ReadonlyArray<AgentFewShot>;
    /**
     * Turn cap from the agent definition. `AgentHarnessOptions` exposes no
     * turn limit, so this is enforced by counting `turn_end` on the child
     * and aborting it — without that the frontmatter value stays inert.
     */
    maxTurns?: number;
    /**
     * Pre-computed child depth. Callers that already needed it (e.g. for tool
     * filtering) pass it here to avoid a second openSession() round-trip.
     * If omitted, we compute it from the parent session's metadata.
     */
    childDepth?: number;
    /**
     * What the child may load on demand. The profile's declared tool list
     * plus the main-session-only names the depth guard strips — without it a
     * subagent could load `configPatch` or a PDF writer its profile never
     * asked for.
     */
    toolPolicy?: AgentToolPolicy;
    /**
     * The run's budget. Read live by the budget reminder hook, so the model
     * is warned as the run nears a limit instead of being cut off mid-turn.
     * The runner updates `turnsUsed` on every completed turn.
     */
    budget?: SubagentBudgetState;
    /**
     * Pre-rendered `<forked_context>` block, or undefined when this child runs
     * independent. Computed by `spawnSubagent` from the parent branch before
     * delegating; injected ahead of few-shots/role and persisted into the child
     * metadata so chatToAgent resumes byte-identically.
     */
    forkedContext?: string;
    /**
     * Pre-generated child session id. A `background: true` spawn needs the id
     * before the run finishes (to hand back in the launch receipt), so it is
     * generated by the caller instead of inside `runSubagentSession`. Omitted
     * by the synchronous path, which has no use for the id before settling.
     */
    childSessionId?: SessionId;
    /** Calling tool's `onUpdate` sink — see subagentRunner for what it emits. */
    onUpdate?: SubagentProgressSink;
    /**
     * Whether chatToAgent can resume this child. `agent` spawns pass
     * `resumable`; skill subagents must not, because their `skill:<name>`
     * agentType has no entry in the agent registry and `runResume` fails closed
     * on a missing definition.
     */
    resumability?: SubagentResumability;
    /** Engine for this run; absent = "standard". */
    runtime?: SubagentRuntime;
    executionId?: string;
    resume?: boolean;
    backgroundLifecycle?: boolean;
}

export class AgentSpawner extends EventEmitter {
    readonly sessionCwd: WorkspaceId;
    readonly workspaceKey: WorkspaceId;

    /** Root for sidecar-owned session-adjacent state; see `AgentSpawnerOptions`. */
    private readonly sessionsRoot: string;
    private readonly getAllowedCwds: () => readonly string[];
    readonly env: NodeExecutionEnv;
    readonly models: MutableModels;
    /** Public so tests can assert on the live parent toolset a spawn would see. */
    readonly getTools: () => TacoTool[];
    /** NOT readonly: `replaceAgents` swaps the catalog after an `agents.write`. */
    agents: AgentDefinition[];
    private readonly sessionRegistry: SessionRegistry;
    private readonly systemPromptContributors: SystemPromptContributor[];
    /** Claude Code SDK/CLI lookup. Fields rather than imports so tests can swap them. */
    private loadClaudeCodeSdk = loadClaudeAgentSdk;
    private findClaudeCode = findClaudeExecutable;
    private loadCodexSdkForRun = loadCodexSdk;
    readonly conversation: AgentConversationRuntime;
    private readonly chatRuns = new Map<
        string,
        {
            parentSessionId: SessionId;
            parentToolCallId: string;
            subSessionId: SessionId;
            agentType: string;
            runId: string;
            messageId: string;
        }
    >();

    constructor(options: AgentSpawnerOptions) {
        super();
        this.sessionCwd = options.cwd;
        this.workspaceKey = options.workspaceKey ?? options.cwd;
        this.sessionsRoot = options.sessionsRoot;
        this.env = options.env;
        this.getAllowedCwds = options.getAllowedCwds ?? (() => [this.env.cwd]);
        this.models = options.models;
        this.getTools = options.getTools;
        this.agents = options.agents;
        this.sessionRegistry = options.sessionRegistry;
        this.systemPromptContributors = options.systemPromptContributors ?? [];
        // Snapshot of the parent workspace's default model. Used as the
        // identity string in rebuilt subagent prompts; per-spawn overrides
        // (`args.model`) take precedence when the caller passes one.
        this.defaultModelIdentity = options.defaultModel
            ? `${options.defaultModel.provider}/${options.defaultModel.id}`
            : undefined;
        this.projectContext = options.projectContext ?? "";
        this.environmentContext = options.environmentContext;
        this.hideWorkspacePath = options.hideWorkspacePath;
        this.getParentInstructionsBlock = options.getParentInstructionsBlock ?? (() => "");
        this.getDeferredToolCatalog = options.getDeferredToolCatalog ?? (() => []);
        this.workHooks = options.workHooks;
        // In-flight resume promises keyed by subSessionId. Concurrent calls
        // share one promise instead of racing to re-attach the same session —
        // a second caller would otherwise see `attachChild` return the existing
        // AttachedSession, but each call would queue its own `prompt()` on it
        // and interleave user messages onto the same branch.
        this.resumeInFlight = new Map();
        this.inFlight = new Map();
        this.backgroundInFlight = new Set();
        this.settledEmitted = new Set();
        this.flushingParents = new Set();
        this.deferredIdleFlushes = new Set();
        this.pendingWriteQueues = new Map();
        this.backgroundRuns = new Set();
        this.subagentControllers = new Map();
        this.controllerWaiters = new Map();
        this.conversation = new AgentConversationRuntime({
            registry: this.sessionRegistry,
            findAgent: (name) => this.findAgent(name),
            start: (message, args) => this.startConversationRun(message, args),
        });
        // Detached parents retry on attach; busy parents retry after their lane
        // has settled. Neither signal may wait for a model notification to finish.
        const flushPending = ({ sessionId }: { sessionId: SessionId }): void => {
            void this.flushPendingSubagentResults(sessionId);
        };
        this.sessionRegistry.on("session.attached", flushPending);
        this.sessionRegistry.on("session.idle", ({ sessionId }: { sessionId: SessionId }) => {
            if (!this.workHooks?.beginParentNotice) return;
            if (this.flushingParents.has(sessionId)) this.deferredIdleFlushes.add(sessionId);
            else void this.flushPendingSubagentResults(sessionId, true);
        });
    }

    /** Returns the parent default-model identity, used when `args.model` is omitted. */
    private readonly defaultModelIdentity: string | undefined;

    /** Workspace-level `<project_context>` block, passed through to rebuilt subagent prompts. */
    private readonly projectContext: string;
    /** Workspace-level `<environment>` snapshot, passed through to rebuilt subagent prompts. */
    private readonly environmentContext: EnvironmentContext | undefined;
    /** Parent's IM/third-party channel flag, inherited by every rebuilt subagent prompt. */
    private readonly hideWorkspacePath: boolean | undefined;
    /**
     * Reads the parent instruction blocks (CLAUDE.md / AGENTS.md / DESIGN.md)
     * to inherit into subagent system prompts. Returns "" when nothing resolved
     * or inheritance is disabled via `InstructionsConfig.inheritToSubagents=false`.
     * Called per spawn/resume so a `settings.write` reaches the next child.
     */
    private readonly getParentInstructionsBlock: () => string;
    private readonly getDeferredToolCatalog: () => readonly DeferredToolCatalogEntry[];
    private readonly workHooks: BackgroundWorkHooks | undefined;

    /** In-flight resume promises, keyed by subSessionId. */
    private readonly resumeInFlight: Map<
        SessionId,
        Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }>
    >;

    /**
     * parentSessionId → set of parentToolCallIds whose subagent is still running.
     *
     * This is the authoritative liveness signal for an agent tool card. A history
     * read cannot distinguish "subagent died with the process" from "subagent is
     * still working" — both look like a toolCall with no toolResult on disk. This
     * set answers that question: it lives in process memory, so it is necessarily
     * empty for sessions whose run ended when a previous process exited, and
     * necessarily populated for subagents actually in flight right now.
     *
     * Surfaced through `session.attach` so the desktop can expire orphaned cards
     * without misfiring on live ones. See `inFlightAgentToolCallIds`.
     */
    private readonly inFlight: Map<SessionId, Set<string>>;

    /**
     * parentToolCallIds of currently-running `background: true` spawns, across
     * every parent session. Separate from `inFlight`: that map exists for the
     * desktop's orphan-card detection and is keyed per parent session, while
     * this is a flat set whose *size* enforces
     * `MAX_CONCURRENT_BACKGROUND_SUBAGENTS` workspace-wide. A background spawn
     * is added to both — `inFlight` for the UI liveness signal, this one for
     * the concurrency gate — and removed from both on settle.
     */
    private readonly backgroundInFlight: Set<string>;

    /**
     * `parentToolCallId`s that have already emitted `subagent.settled`,
     * for the background spawn currently settling.
     *
     * Both the delivery path and its error path emit, so this keeps the event
     * at-most-once per background spawn while its settle sequence (persist,
     * record, deliver, clear) is in flight — the `.then` and `.catch`
     * branches for one spawn can both reach `emitSettled` (e.g. delivery
     * itself throws after the success path already emitted). Entries are
     * removed in the settle chain's `.finally`, once no later call for that
     * `parentToolCallId` can still be in flight; tool call ids are never
     * reused, so this is not a TTL or an LRU, just "done with this one".
     */
    private readonly settledEmitted: Set<string>;

    /**
     * Parent sessions with a flush in progress.
     *
     * Two attaches in quick succession would otherwise both read the same
     * pending record and deliver every notice twice.
     */
    private readonly flushingParents: Set<SessionId>;

    /** Idle wakes arriving during pending/claim writes must survive the current flush. */
    private readonly deferredIdleFlushes: Set<SessionId>;

    /**
     * Tail of the serialized pending-record queue for each parent session.
     *
     * `recordPending` / `dropPending` / `flushPendingSubagentResults` each do
     * a read-modify-write of the same per-parent value (the whole
     * `PendingMap`, see `subagentPending.ts`). Up to
     * `MAX_CONCURRENT_BACKGROUND_SUBAGENTS` children of one parent can settle
     * within the same tick, so without this queue two concurrent
     * `recordPending` calls race: both read the map before either writes,
     * and the second write clobbers the first entry — exactly the record
     * this module exists to not lose. Same swallow-then-await shape as
     * `SessionRegistry.withSession`'s `detachedReads`.
     */
    private readonly pendingWriteQueues: Map<SessionId, Promise<void>>;

    /**
     * Settle sequences of launched background spawns that have not finished.
     *
     * Each entry covers everything after the child stops: persist the result,
     * record it pending, deliver the notice, clear the record. Held only so
     * `whenBackgroundRunsSettle` can await them — a spawn never waits on its own
     * entry, and every rejection is already handled inside the chain.
     */
    private readonly backgroundRuns: Set<Promise<void>>;

    /**
     * subSessionId → controller that stops that child's run, for every run
     * currently executing (sync, resume, or background). `abortSubagentRun`
     * fires it; the runner's signal listener does the rest. Entries live only
     * while the child harness runs — outside that window there is nothing to
     * stop and `abortSubagentRun` says so. The owning parent is stored so a
     * caller can be restricted to stopping its own children.
     */
    private readonly subagentControllers: Map<
        string,
        { controller: AbortController; parentSessionId: SessionId }
    >;

    /**
     * Resolvers parked by `stopChildrenOf`, keyed by the subSessionId they are
     * waiting on. Released from `releaseController`, so a waiter observes the
     * same moment the controller entry disappears — no polling.
     */
    private readonly controllerWaiters: Map<string, Set<() => void>>;

    /**
     * Drop a child's controller entry and release anyone waiting on it.
     *
     * Every removal goes through here so `stopChildrenOf` cannot wait forever
     * on a child that has in fact finished: an entry that vanished without
     * resolving its waiter would strand the caller until its own timeout.
     */
    private releaseController(subSessionId: string, expected?: AbortController): void {
        if (expected && this.subagentControllers.get(subSessionId)?.controller !== expected) return;
        this.subagentControllers.delete(subSessionId);
        const waiters = this.controllerWaiters.get(subSessionId);
        if (!waiters) return;
        this.controllerWaiters.delete(subSessionId);
        for (const resolve of waiters) resolve();
    }

    /**
     * Abort every running child of `parentSessionId` and wait for them to stop,
     * giving up after `timeoutMs`.
     *
     * Aborting only fires the signal — the child harness unwinds asynchronously,
     * and its session stays open until it does. A caller that goes on to delete
     * the parent (and therefore the children's transcripts) has to wait for that
     * window or pi's repo rejects the delete with "Session is open".
     *
     * Returns the children still running when the wait ended, so the caller can
     * skip them rather than fail the whole operation over one slow child. On
     * timeout this list is non-empty; on a clean stop it is empty.
     */
    async stopChildrenOf(parentSessionId: SessionId, timeoutMs = 5_000): Promise<SessionId[]> {
        const running = [...this.subagentControllers.entries()]
            .filter(([, entry]) => entry.parentSessionId === parentSessionId)
            .map(([subSessionId]) => asSessionId(subSessionId));
        if (running.length === 0) return [];

        const stopped = running.map(
            (subSessionId) =>
                new Promise<void>((resolve) => {
                    let waiters = this.controllerWaiters.get(subSessionId);
                    if (!waiters) {
                        waiters = new Set();
                        this.controllerWaiters.set(subSessionId, waiters);
                    }
                    waiters.add(resolve);
                }),
        );
        for (const subSessionId of running) this.abortSubagentRun(subSessionId, parentSessionId);

        await Promise.race([
            Promise.all(stopped),
            new Promise<void>((r) => setTimeout(r, timeoutMs)),
        ]);

        return running.filter((subSessionId) => this.subagentControllers.has(subSessionId));
    }

    /** Looks up a subagent definition in the registry by `agentType`. */
    findAgent(type: string): AgentDefinition | undefined {
        return this.agents.find((a) => a.agentType === type);
    }

    /** Canonical Codex cwd, constrained to the workspace/associated roots. */
    private async resolveCodexCwd(requested?: string): Promise<string> {
        const candidate = await realpath(requested ?? this.env.cwd).catch(() => undefined);
        if (!candidate)
            throw new Error(`Codex cwd is not an existing directory: ${requested ?? this.env.cwd}`);
        const isDir = await stat(candidate)
            .then((entry) => entry.isDirectory())
            .catch(() => false);
        if (!isDir) throw new Error(`Codex cwd is not an existing directory: ${candidate}`);
        const allowed = await Promise.all(
            this.getAllowedCwds().map((root) => realpath(root).catch(() => undefined)),
        );
        if (!allowed.includes(candidate)) {
            throw new Error(
                `Codex cwd must be the workspace directory or one of its associated directories: ${candidate}`,
            );
        }
        return candidate;
    }

    /** Detect a Git worktree even when cwd is a nested directory. */
    private async isInsideGitWorktree(cwd: string): Promise<boolean> {
        let current = cwd;
        while (true) {
            const found = await stat(join(current, ".git"))
                .then(() => true)
                .catch(() => false);
            if (found) return true;
            const parent = dirname(current);
            if (parent === current) return false;
            current = parent;
        }
    }

    /**
     * Fail before creating a child when the SDK or its platform binary is
     * missing.
     *
     * Credentials are not checked here: the run uses the user's own Codex
     * configuration, and a custom provider carries its own credentials, so
     * only Codex itself can say whether a turn can authenticate. Blocking on
     * our own guess would refuse runs that work.
     */
    private async preflightCodexRuntime(): Promise<void> {
        let loaded: LoadedCodexSdk;
        try {
            loaded = await this.loadCodexSdkForRun();
            createCodexClient(loaded.module, { env: scrubbedProcessEnv() });
        } catch (error) {
            throw new Error(codexRuntimeUnavailableMessage(error));
        }
    }

    /** Swap the agent catalog after an `agents.write` / `agents.delete` rescan. */
    replaceAgents(next: AgentDefinition[]): void {
        this.agents = next;
    }

    /** parentToolCallIds with a live subagent under `parentSessionId`. */
    inFlightAgentToolCallIds(parentSessionId: SessionId): string[] {
        return [...(this.inFlight.get(parentSessionId) ?? [])];
    }

    /**
     * Stop one running subagent without touching its parent's turn.
     *
     * False means "no such run right now" — it already settled, or never ran
     * in this process. The stop itself is asynchronous: firing the controller
     * aborts the child harness, and the sync caller (or the background
     * notification) learns the outcome through the normal settle path.
     */
    abortSubagentRun(subSessionId: string, forParentSessionId?: SessionId): boolean {
        const entry = this.subagentControllers.get(subSessionId);
        if (!entry || entry.controller.signal.aborted) return false;
        if (forParentSessionId !== undefined && entry.parentSessionId !== forParentSessionId) {
            return false;
        }
        entry.controller.abort();
        return true;
    }

    /** Child-attach inputs this spawner owns — one definition so spawn and resume agree. */
    private get childAttachDeps(): ChildAttachDeps {
        return {
            toolsForChildSession: (sessionId) =>
                this.sessionRegistry.toolsForChildSession(sessionId),
            systemPromptContributors: this.systemPromptContributors,
            projectContext: this.projectContext,
            environmentContext: this.environmentContext,
            hideWorkspacePath: this.hideWorkspacePath,
            getParentInstructionsBlock: this.getParentInstructionsBlock,
            getDeferredToolCatalog: this.getDeferredToolCatalog,
        };
    }

    /**
     * Mark a parent tool call as having a live subagent for the duration of `run`.
     * Registered before the child session exists so the attach window is covered,
     * and released on settle whichever way `run` ends.
     */
    private async trackInFlight<T>(
        parentSessionId: SessionId,
        parentToolCallId: string,
        run: () => Promise<T>,
    ): Promise<T> {
        let ids = this.inFlight.get(parentSessionId);
        if (!ids) {
            ids = new Set();
            this.inFlight.set(parentSessionId, ids);
        }
        ids.add(parentToolCallId);
        try {
            return await run();
        } finally {
            const current = this.inFlight.get(parentSessionId);
            if (current) {
                current.delete(parentToolCallId);
                if (current.size === 0) this.inFlight.delete(parentSessionId);
            }
        }
    }

    /**
     * Core subagent execution: create session → emit spawned → attach harness →
     * run prompt → extract result. Used by both spawnSubagent (agent tool) and
     * runSkillSubagent (Skill tool subagent mode).
     *
     * Never throws — errors (including `repo.create` / attach failures) are
     * wrapped in `{ isError: true }`. The background fire-and-forget chain
     * in `spawnBackgroundSubagent` relies on this: `.then` always fires, so
     * a launch failure still reaches the parent as an error notification
     * instead of dying in `.catch` as a log line.
     */
    async executeSubagentSession(args: SubagentSessionArgs): Promise<SubagentRunResult> {
        const childSessionId = args.childSessionId ?? asSessionId(uuidv7());
        const runId = args.executionId ?? uuidv7();
        if (!this.conversation.state(childSessionId))
            this.conversation.begin(childSessionId, {
                runId,
                parentSessionId: args.parentSessionId,
                runtime: args.runtime,
                phase: "preparing",
            });
        let result: SubagentRunResult | undefined;
        try {
            result = await this.trackInFlight(
                args.parentSessionId,
                args.parentToolCallId,
                async () => {
                    try {
                        return await this.runSubagentSession({
                            ...args,
                            childSessionId,
                            executionId: runId,
                        });
                    } catch (error) {
                        return {
                            subSessionId: childSessionId,
                            resultText: error instanceof Error ? error.message : String(error),
                            isError: true,
                        };
                    }
                },
            );
            return result;
        } finally {
            this.conversation.settling(childSessionId);
            if (!args.backgroundLifecycle)
                await this.conversation.end(childSessionId, runId, result);
        }
    }

    /** `executeSubagentSession` body, wrapped by it for in-flight tracking. */
    private async runSubagentSession(args: SubagentSessionArgs): Promise<SubagentRunResult> {
        // Caller must supply `childDepth` — used by tool filtering to gate Skill/agent
        // recursion, and computing it here would require a second openSession() call.
        const childDepth =
            args.childDepth ??
            (() => {
                throw new Error("executeSubagentSession: childDepth must be provided by caller");
            })();

        // 1. Create child session. pi 0.85 fixed the metadata shape, so the
        //    sidecar's own attributes are written as session values straight
        //    after creation rather than passed to create(). Created under the
        //    registry's per-id slot so a reader holding the id from a
        //    background launch receipt cannot race the create handle.
        const childSessionId = args.childSessionId ?? uuidv7();
        await this.sessionRegistry.createSession(
            asSessionId(childSessionId),
            args.parentSessionId,
            async (session) => {
                await writeSessionFacts(session, {
                    kind: "subagent",
                    agentType: args.agentType,
                    parentSessionId: args.parentSessionId,
                    parentToolCallId: args.parentToolCallId,
                    depth: childDepth,
                    ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
                    ...(args.forkedContext !== undefined
                        ? { forkedContext: args.forkedContext }
                        : {}),
                });
            },
        );

        // A claude-code child never attaches, so the push layer cannot read
        // its kind from the attached map. Register it here — before the first
        // event — so its frames route as "subagent" from the start.
        this.sessionRegistry.noteSessionKind(asSessionId(childSessionId), "subagent");

        // 2. Emit spawned (same agentType as the persisted facts)
        this.emit("subagent.spawned", {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            subSessionId: childSessionId,
            agentType: args.agentType,
            ...(args.executionId !== undefined ? { runId: args.executionId } : {}),
        });

        if (args.runtime === "claude-code") {
            return this.runClaudeCodeChild(asSessionId(childSessionId), args);
        }
        if (args.runtime === "codex") {
            return this.runCodexChild(asSessionId(childSessionId), args);
        }

        // 3. Build the child's toolset + system prompt.
        const {
            tools: childTools,
            taskState: childTaskState,
            systemPrompt: childSystemPrompt,
        } = await prepareChildAttach(this.childAttachDeps, {
            sessionId: asSessionId(childSessionId),
            agentType: args.agentType,
            childDepth,
            allowedTools: args.tools,
            ...(args.toolPolicy !== undefined ? { toolPolicy: args.toolPolicy } : {}),
            rolePrompt: args.rolePrompt,
            fewShots: args.fewShots,
            forkedContext: args.forkedContext,
            // Per-spawn model override wins over the parent default. Without an
            // override we keep the parent's identity string so the subagent's
            // `<model_identity>` section reflects what actually runs.
            modelIdentity: args.model
                ? `${args.model.provider}/${args.model.id}`
                : this.defaultModelIdentity,
        });

        // 4. Attach child harness
        let attached: AttachedSession;
        try {
            attached = await this.sessionRegistry.attachChild(
                asSessionId(childSessionId),
                {
                    thinkingLevel: "off",
                    model: args.model,
                    ...(args.toolPolicy !== undefined ? { toolLoadPolicy: args.toolPolicy } : {}),
                    ...(args.budget !== undefined ? { getSubagentBudget: () => args.budget } : {}),
                } satisfies AttachOptions,
                childTools,
                childTaskState,
                childSystemPrompt,
            );
        } catch (e) {
            return {
                subSessionId: asSessionId(childSessionId),
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        }

        // Registered only while the child harness runs: before this there is
        // nothing to stop, after it the run has settled — `abortSubagentRun`
        // reporting "not running" outside the window is the truth.
        if (args.abortController) {
            this.subagentControllers.set(childSessionId, {
                controller: args.abortController,
                parentSessionId: args.parentSessionId,
            });
        }
        try {
            return await runAttachedSubagent({
                subSessionId: asSessionId(childSessionId),
                attached,
                prompt: args.prompt,
                agentType: args.agentType,
                maxTurns: args.maxTurns,
                ...(args.budget !== undefined ? { budget: args.budget } : {}),
                signal: args.signal,
                onUpdate: args.onUpdate,
                resumability: args.resumability,
                readLastAssistantText: (id) => this.extractLastAssistantText(id),
            });
        } finally {
            if (args.abortController) this.releaseController(childSessionId);
        }
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
        /** Short task label, echoed on the background completion notice. */
        description?: string;
        context?: SubagentContextMode;
        background?: boolean;
        signal?: AbortSignal;
        onUpdate?: SubagentProgressSink;
    }): Promise<{
        subSessionId?: SessionId;
        resultText: string;
        isError: boolean;
        aborted?: boolean;
        background?: boolean;
        /** Set only for a launched background spawn; see `SubagentSpawnContext`. */
        resultPath?: string;
    }> {
        const def = this.findAgent(args.agentType);
        if (!def) {
            // No child session was created, so there is no id to report. An
            // empty string would satisfy a `SessionId` annotation and slip past
            // `typeof x === "string"` narrowings, only to fail the truthiness
            // guards further downstream — where a real spawn failure is
            // indistinguishable from a successful one whose id went missing.
            return {
                resultText: `unknown agent type: ${args.agentType}`,
                isError: true,
            };
        }
        // A fixed directory that has since been moved or deleted fails the
        // spawn: running the CLI somewhere else instead would point a
        // write-capable agent at a tree its author never chose. Checked before
        // the slot is reserved so the failure leaves nothing behind.
        if (def.runtime === "claude-code" && def.cwd !== undefined) {
            const isDir = await stat(def.cwd)
                .then((s) => s.isDirectory())
                .catch(() => false);
            if (!isDir) {
                return {
                    resultText:
                        `agent type "${def.agentType}" is set to run in ${def.cwd}, which is not an ` +
                        "existing directory. Ask the user to fix the subagent's directory in its settings.",
                    isError: true,
                    ...(args.background ? { background: true as const } : {}),
                };
            }
        }
        if (def.runtime === "codex") {
            try {
                await this.resolveCodexCwd(def.codex?.cwd);
                await this.preflightCodexRuntime();
            } catch (error) {
                return {
                    resultText: error instanceof Error ? error.message : String(error),
                    isError: true,
                    ...(args.background ? { background: true as const } : {}),
                };
            }
        }
        // Reserve the background slot before any `await` so two concurrent
        // launches cannot both pass a stale `size` check. Released in
        // `spawnBackgroundSubagent`'s `.finally`, or here if we bail before
        // that run is kicked off. Duplicate `parentToolCallId` is a retry of
        // the same tool call, not a second spawn — reject rather than count
        // twice and delete once.
        if (args.background) {
            if (this.backgroundInFlight.has(args.parentToolCallId)) {
                return {
                    resultText:
                        "a background subagent for this tool call is already running; " +
                        "wait for it to finish instead of launching a duplicate.",
                    isError: true,
                    background: true,
                };
            }
            if (this.backgroundInFlight.size >= MAX_CONCURRENT_BACKGROUND_SUBAGENTS) {
                return {
                    resultText:
                        "too many background subagents already running " +
                        `(limit ${MAX_CONCURRENT_BACKGROUND_SUBAGENTS}). Wait for one to finish, or run this ` +
                        "one synchronously instead.",
                    isError: true,
                    background: true,
                };
            }
            this.backgroundInFlight.add(args.parentToolCallId);
        }
        try {
            return await this.prepareAndRunSpawn(args, def);
        } catch (e) {
            if (args.background) this.backgroundInFlight.delete(args.parentToolCallId);
            return {
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
                ...(args.background ? { background: true as const } : {}),
            };
        }
    }

    /**
     * `runtime: claude-code` body of `runSubagentSession`, after the child
     * session exists. The transcript is appended through `withSession` one
     * batch at a time rather than through a held handle, so a concurrent
     * history read from the desktop queues behind it instead of failing on
     * pi's "already open" guard.
     */
    private async runClaudeCodeChild(
        childSessionId: SessionId,
        args: SubagentSessionArgs,
    ): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        aborted?: boolean;
    }> {
        // The SDK takes a controller, not a signal. Spawn paths always pass one;
        // a caller with only `signal` gets a controller that follows it.
        const controller = args.abortController ?? new AbortController();
        const follow = (): void => controller.abort();
        if (args.signal?.aborted) controller.abort();
        args.signal?.addEventListener("abort", follow, { once: true });
        this.subagentControllers.set(childSessionId, {
            controller,
            parentSessionId: args.parentSessionId,
        });
        try {
            const native = args.resume
                ? await this.sessionRegistry.withSession(childSessionId, readClaudeCodeState)
                : undefined;
            if (args.resume && !native)
                return {
                    subSessionId: childSessionId,
                    isError: true,
                    resultText:
                        "This Claude Code session cannot be resumed: its native session mapping was not saved. Create a fresh agent explicitly.",
                };
            const cwd = args.claudeCodeCwd ?? this.env.cwd;
            if (
                native &&
                (native.cwd !== cwd ||
                    native.configDir !== process.env.CLAUDE_CONFIG_DIR ||
                    JSON.stringify(native.tools) !== JSON.stringify(args.claudeCodeTools) ||
                    native.permissionMode !== args.permissionMode)
            )
                return {
                    subSessionId: childSessionId,
                    isError: true,
                    resultText:
                        "Claude Code continuation requires the original cwd, storage environment, tools and permission mode. The profile changed; create a new agent explicitly.",
                };
            const communicationNames = (["chatToAgent", "listAgentSessions"] as const).filter(
                (name) =>
                    args.claudeCodeTools === undefined ||
                    args.claudeCodeTools.includes(name) ||
                    args.claudeCodeTools.includes(`mcp__taco__${name}`),
            );
            const nativeTools = args.claudeCodeTools?.filter(
                (name) =>
                    ![
                        "chatToAgent",
                        "listAgentSessions",
                        "mcp__taco__chatToAgent",
                        "mcp__taco__listAgentSessions",
                    ].includes(name),
            );
            return await runClaudeCodeSubagent({
                subSessionId: childSessionId,
                resumeSessionId: native?.nativeSessionId,
                onSessionId: (nativeSessionId) =>
                    this.sessionRegistry.withSession(childSessionId, (session) =>
                        writeClaudeCodeState(session, {
                            nativeSessionId,
                            cwd,
                            configDir: process.env.CLAUDE_CONFIG_DIR,
                            tools: args.claudeCodeTools,
                            permissionMode: args.permissionMode,
                        }),
                    ),
                onInputReady: (input) => this.conversation.setInput(childSessionId, input),
                ...(communicationNames.length
                    ? {
                          communicationTools: {
                              allowedNames: communicationNames,
                              chat: (input: {
                                  subSessionId: string;
                                  prompt: string;
                                  delivery?: "steer" | "followUp";
                                  background?: boolean;
                                  inReplyTo?: string;
                              }) =>
                                  this.chatToAgent(childSessionId, {
                                      ...input,
                                      subSessionId: asSessionId(input.subSessionId),
                                      parentToolCallId: `cc-message:${uuidv7()}`,
                                  }),
                              list: () => this.listAgentSessions(childSessionId),
                          },
                      }
                    : {}),
                agentType: args.agentType,
                prompt: args.prompt,
                rolePrompt: args.rolePrompt,
                maxTurns: args.maxTurns,
                tools: nativeTools,
                permissionMode: args.permissionMode,
                cwd: args.claudeCodeCwd ?? this.env.cwd,
                abortController: controller,
                onUpdate: args.onUpdate,
                loadSdk: this.loadClaudeCodeSdk,
                findExecutable: () => this.findClaudeCode(),
                appendMessages: (messages) =>
                    this.sessionRegistry.withSession(childSessionId, async (session) => {
                        const branch =
                            (await session.branch(MAIN_BRANCH, harnessContext)) ??
                            (await session.createBranch(MAIN_BRANCH, null, harnessContext));
                        for (const m of messages) {
                            await branch.appendMessage(m, harnessContext);
                            this.pushChildMessages(childSessionId, m);
                        }
                    }),
            });
        } finally {
            args.signal?.removeEventListener("abort", follow);
            this.releaseController(childSessionId, controller);
        }
    }

    /**
     * `runtime: codex` body of `runSubagentSession`. The SDK thread is the
     * native conversation; Taco persists only the mapping and display
     * transcript. A resume must use exactly the saved thread and the same
     * immutable cwd/profile options.
     */
    private async runCodexChild(
        childSessionId: SessionId,
        args: SubagentSessionArgs,
    ): Promise<SubagentRunResult> {
        const controller = args.abortController ?? new AbortController();
        const follow = (): void => controller.abort(args.signal?.reason);
        if (args.signal?.aborted) controller.abort(args.signal.reason);
        args.signal?.addEventListener("abort", follow, { once: true });
        this.subagentControllers.set(childSessionId, {
            controller,
            parentSessionId: args.parentSessionId,
        });
        let communicationBridge: CodexCommunicationBridge | undefined;
        try {
            if (args.resume) await this.preflightCodexRuntime();
            let cwd: string;
            try {
                cwd = await this.resolveCodexCwd(args.codexConfig?.cwd);
            } catch (error) {
                return {
                    subSessionId: childSessionId,
                    isError: true,
                    resultText: error instanceof Error ? error.message : String(error),
                };
            }
            // No model override means the user's own Codex configuration
            // decides — the same rule a Claude Code agent follows.
            const model = args.codexConfig?.model?.trim();
            const configWithoutModel = { ...(args.codexConfig ?? {}) };
            delete configWithoutModel.model;
            const effectiveConfig = {
                ...configWithoutModel,
                ...(model !== undefined && model !== "" ? { model } : {}),
                sandbox: args.codexConfig?.sandbox ?? ("read-only" as const),
                approvalPolicy: args.codexConfig?.approvalPolicy ?? ("never" as const),
            };
            const skipGitRepoCheck = !(await this.isInsideGitWorktree(cwd));
            const communicationNames = (["chatToAgent", "listAgentSessions"] as const).filter(
                (name) =>
                    args.codexTools === undefined ||
                    args.codexTools.includes(name) ||
                    args.codexTools.includes(`mcp__taco__${name}`),
            );
            const profileIdentity = codexProfileIdentity(
                args.agentType,
                effectiveConfig,
                communicationNames,
                args.rolePrompt,
            );
            const native = args.resume
                ? await this.sessionRegistry.withSession(childSessionId, readCodexState)
                : undefined;
            if (args.resume && !native) {
                return {
                    subSessionId: childSessionId,
                    isError: true,
                    resultText:
                        "This Codex session cannot be resumed because its native thread mapping was not saved. " +
                        "Create a fresh agent explicitly.",
                };
            }
            if (
                native &&
                (native.cwd !== cwd ||
                    native.profileIdentity !== profileIdentity ||
                    native.sdkVersion !== CODEX_SDK_VERSION ||
                    native.threadOptions.skipGitRepoCheck !== skipGitRepoCheck)
            ) {
                return {
                    subSessionId: childSessionId,
                    isError: true,
                    resultText:
                        "Codex continuation requires the original cwd, SDK version, and profile options. " +
                        "The profile changed; create a new agent explicitly.",
                };
            }
            const state: CodexState = native ?? {
                nativeThreadId: "",
                cwd,
                profileIdentity,
                sdkVersion: CODEX_SDK_VERSION,
                threadOptions: {
                    ...(effectiveConfig.model !== undefined
                        ? { model: effectiveConfig.model }
                        : {}),
                    sandbox: effectiveConfig.sandbox,
                    approvalPolicy: effectiveConfig.approvalPolicy,
                    skipGitRepoCheck,
                    ...(communicationNames.length > 0
                        ? { communicationTools: communicationNames }
                        : {}),
                },
            };
            if (communicationNames.length > 0) {
                communicationBridge = await createCodexCommunicationBridge({
                    allowedNames: communicationNames,
                    chat: (input) =>
                        this.chatToAgent(childSessionId, {
                            ...input,
                            subSessionId: asSessionId(input.subSessionId),
                            parentToolCallId: `codex-message:${uuidv7()}`,
                        }),
                    list: () => this.listAgentSessions(childSessionId),
                });
            }
            this.conversation.markRunning(childSessionId, args.executionId);
            return await runCodexSubagent({
                subSessionId: childSessionId,
                agentType: args.agentType,
                prompt: args.prompt,
                ...(native ? { resumeThreadId: native.nativeThreadId } : {}),
                ...(native
                    ? {}
                    : {
                          onThreadId: async (nativeThreadId: string) => {
                              await this.sessionRegistry.withSession(childSessionId, (session) =>
                                  writeCodexState(session, { ...state, nativeThreadId }),
                              );
                          },
                      }),
                rolePrompt: args.rolePrompt,
                config: effectiveConfig,
                ...(communicationBridge
                    ? { mcpServers: { taco: communicationBridge.mcpServer } }
                    : {}),
                cwd,
                skipGitRepoCheck,
                abortController: controller,
                onUpdate: args.onUpdate,
                loadSdk: async () => (await this.loadCodexSdkForRun()).module,
                appendMessages: (messages) =>
                    this.sessionRegistry.withSession(childSessionId, async (session) => {
                        const branch =
                            (await session.branch(MAIN_BRANCH, harnessContext)) ??
                            (await session.createBranch(MAIN_BRANCH, null, harnessContext));
                        for (const message of messages) {
                            await branch.appendMessage(message, harnessContext);
                            this.pushChildMessages(childSessionId, message);
                        }
                    }),
            });
        } finally {
            try {
                await communicationBridge?.close();
            } catch (error) {
                log.warn("Codex communication bridge cleanup failed", {
                    subSessionId: childSessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            args.signal?.removeEventListener("abort", follow);
            this.releaseController(childSessionId, controller);
        }
    }

    /**
     * Push one persisted child message as pi-style events so the desktop panel
     * streams it live. The registry routes by the facts cache (`noteSessionKind`),
     * so the frame lands in `childMessagesBySubSessionId` as a subagent.
     *
     * Order matters, because the desktop reducer attaches each tool event to
     * the *last assistant bubble*. pi always opens that bubble first; a
     * `tool_start` that arrives with no bubble to land in is rendered as a
     * plain fallback text row ("▶ Read", "✓ Grep: …") instead of a card. So an
     * assistant message is replayed the way pi emits one:
     *
     *   message_start → message_end (text + thinking) → tool_start per call
     *
     * and a toolResult as `tool_end`, which then finds its card in that bubble.
     * Both events carry the message's own timestamp — the reducer keys the
     * bubble on it (`live-asst-<timestamp>`), and start and end must agree.
     */
    private pushChildMessages(subSessionId: SessionId, m: AgentMessage): void {
        const emit = (event: object) =>
            this.emit("session.event", { sessionId: subSessionId, event });
        if (m.role === "user") {
            emit({ type: "message_end", message: m });
            return;
        }
        if (m.role === "assistant") {
            emit({ type: "message_start", message: m });
            emit({ type: "message_end", message: m });
            const content = (m as { content?: unknown[] }).content ?? [];
            for (const c of content) {
                if (typeof c !== "object" || c === null) continue;
                const block = c as {
                    type?: string;
                    id?: string;
                    name?: string;
                    arguments?: unknown;
                };
                if (block.type !== "toolCall") continue;
                emit({
                    type: "tool_start",
                    toolCallId: block.id,
                    toolName: block.name,
                    args: block.arguments,
                });
            }
            return;
        }
        if (m.role === "toolResult") {
            const tr = m as {
                toolCallId?: string;
                toolName?: string;
                isError?: boolean;
                content?: unknown;
            };
            emit({
                type: "tool_end",
                toolCallId: tr.toolCallId ?? "",
                toolName: tr.toolName ?? "tool",
                result: { content: tr.content ?? [] },
                isError: tr.isError ?? false,
            });
        }
    }

    /**
     * Depth/toolset/fork prep, then either await the run or fire it off in
     * the background. The background slot (if any) is already reserved by
     * `spawnSubagent`; this method must not add it again.
     */
    private async prepareAndRunSpawn(
        args: {
            parentSessionId: SessionId;
            parentToolCallId: string;
            agentType: string;
            prompt: string;
            description?: string;
            context?: SubagentContextMode;
            background?: boolean;
            signal?: AbortSignal;
            onUpdate?: SubagentProgressSink;
        },
        def: AgentDefinition,
    ): Promise<{
        subSessionId?: SessionId;
        resultText: string;
        isError: boolean;
        background?: boolean;
        resultPath?: string;
    }> {
        // Unlike childDepth there is a safe default, so an omitted value is not
        // a caller error — see resolveContextMode for the precedence rationale.
        const contextMode = resolveContextMode(args.context, def.context);
        // A Claude Code child is a separate process with its own logs and
        // telemetry — a new trust domain — so the parent transcript must not
        // be copied into it (see forkedHistory.ts). The model cannot pass the
        // runtime, so it may well ask for `fork` here; correct the request
        // instead of failing it. `<available_agents>` states the constraint, so
        // a model that reads it never gets here.
        const effectiveContextMode =
            def.runtime === "claude-code" || def.runtime === "codex" ? "independent" : contextMode;
        // Compute parent depth to feed filterToolsForAgent before delegating.
        // Depth lives in the session's value store, not `JsonlSessionMetadata`
        // (pi 0.85 removed the free-form metadata bag), so it needs a read.
        const parentFacts = await this.sessionRegistry.withSession(
            args.parentSessionId,
            (session) => readSessionFacts(session),
        );
        const parentDepth = resolveParentDepth(parentFacts, {
            parentSessionId: args.parentSessionId,
        });
        const childDepth = parentDepth + 1;
        const childTools = filterToolsForAgent(this.getTools(), def.tools, childDepth);
        // Fork: render the parent transcript once, up front. Reading the branch
        // here (not inside runSubagentSession) keeps the I/O out of the hot
        // attach path and lets us persist the exact string the child saw so a
        // later resume re-injects byte-identically.
        let forkedContext: string | undefined;
        if (effectiveContextMode === "fork") {
            forkedContext = await this.sessionRegistry.withSession(
                args.parentSessionId,
                async (parentSession) => buildForkedContext(await findBranchEntries(parentSession)),
            );
        }
        const sessionArgs: SubagentSessionArgs = {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            agentType: def.agentType,
            prompt: args.prompt,
            tools: childTools,
            onUpdate: args.onUpdate,
            // Spawned from a registry profile, so runResume can re-derive the
            // child's toolset from its agentType. Claude Code runs keep no
            // resumable harness state.
            resumability: def.runtime === "claude-code" ? "not_resumable" : "resumable",
            runtime: def.runtime,
            childDepth,
            // The profile's declared tools bound what the child may also load
            // on demand — same list the initial toolset was filtered by.
            toolPolicy: agentToolPolicy(def.tools, childDepth),
            // The run's budget, read live by the budget reminder hook. The
            // background path adds its wall-clock allowance to it.
            budget: {
                turnsUsed: 0,
                startedAt: Date.now(),
                ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
            },
            rolePrompt: def.systemPrompt,
            fewShots: def.fewShots,
            maxTurns: def.maxTurns,
            forkedContext,
            ...(def.runtime === "claude-code"
                ? {
                      claudeCodeTools: def.tools,
                      permissionMode: def.permissionMode,
                      ...(def.cwd !== undefined ? { claudeCodeCwd: def.cwd } : {}),
                  }
                : {}),
            ...(def.runtime === "codex"
                ? {
                      ...(def.codex !== undefined ? { codexConfig: def.codex } : {}),
                      ...(def.tools !== undefined ? { codexTools: def.tools } : {}),
                  }
                : {}),
        };
        if (!args.background) {
            // Synchronous path: still bounded by the caller's signal, but
            // linked into a per-child controller so `abortSubagentRun` can
            // stop this child alone — aborting the parent's signal directly
            // would tear down the whole parent turn.
            const controller = new AbortController();
            if (args.signal?.aborted) controller.abort();
            const link = (): void => controller.abort();
            args.signal?.addEventListener("abort", link, { once: true });
            try {
                return await this.executeSubagentSession({
                    ...sessionArgs,
                    signal: controller.signal,
                    abortController: controller,
                });
            } finally {
                args.signal?.removeEventListener("abort", link);
            }
        }
        return this.spawnBackgroundSubagent(sessionArgs, def, args.description);
    }

    /**
     * `background: true` branch of `spawnSubagent`. Creates the child and
     * returns a launch receipt as soon as it exists — the run itself continues
     * unawaited, bounded by its own timeout rather than the caller's signal
     * (which belongs to the parent turn that is about to return; that turn
     * must not be able to cut this run short by finishing).
     *
     * Never rejects: a failure to even launch (e.g. attach failure) is
     * reported as an error result, same contract as the synchronous path.
     */
    private async spawnBackgroundSubagent(
        sessionArgs: SubagentSessionArgs,
        def: AgentDefinition,
        description?: string,
    ): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        background: true;
        resultPath: string;
    }> {
        const timeoutMs =
            def.timeoutMinutes !== undefined && def.timeoutMinutes > 0
                ? def.timeoutMinutes * 60_000
                : backgroundTimeoutMs(def.maxTurns);
        // The budget object is shared with the run (the reminder hook reads it
        // live), so the wall-clock allowance lands on the same state the turn
        // counter writes to.
        if (sessionArgs.budget) sessionArgs.budget.timeoutMs = timeoutMs;
        const controller = new AbortController();
        // The reason tells the runner this was the run's own budget running out,
        // not a user stop: the two need different words and different advice.
        const timer = setTimeout(
            () =>
                controller.abort({
                    kind: "subagent-timeout",
                    timeoutMinutes: Math.round(timeoutMs / 60_000),
                }),
            timeoutMs,
        );
        const { parentSessionId, parentToolCallId } = sessionArgs;
        // Generated here, not inside runSubagentSession, so the receipt below
        // can report it without waiting for the child session to actually be
        // created. If `repo.create()` subsequently fails, the receipt still
        // named a session that never came to exist — the failure surfaces
        // instead as an error notification once `run` settles (§ below),
        // which is the same "receipt now, truth later" trade-off `background`
        // makes everywhere else. The background slot was reserved by
        // `spawnSubagent` before any await; this method must not add it again.
        const childSessionId = sessionArgs.childSessionId ?? asSessionId(uuidv7());
        const runId = sessionArgs.executionId ?? uuidv7();
        this.conversation.begin(childSessionId, {
            runId,
            parentSessionId,
            runtime: sessionArgs.runtime,
            phase: "preparing",
        });
        // Computed at launch, not at settle: the receipt below carries it, so
        // the model holds the exact path from the moment it delegates. That is
        // what makes the result recoverable when the completion notice never
        // lands (parent mid-compaction, process restarted) — the model can read
        // the file on its own, and a missing file is itself the "still running"
        // answer. Deriving it here also keeps the path a single source of truth
        // shared by the receipt and the write.
        const resultPath = subagentResultPath(
            parentSessionId,
            childSessionId,
            this.sessionsRoot,
            sessionArgs.resume ? runId : undefined,
        );
        // Registered at launch (not when the run starts) so a stop request
        // that arrives during setup still reaches the run: the runner's
        // pre-aborted check turns it into an immediate interruption.
        this.subagentControllers.set(childSessionId, { controller, parentSessionId });
        // Recorded before the run starts: the Work must exist for the whole of
        // its run, or a crash mid-flight leaves nothing for the next start to
        // mark interrupted. Never throws; a failed record means no tracking.
        const workId = await this.workHooks?.onLaunch({
            workspace: this.workspaceKey ?? this.sessionCwd,
            parentSessionId,
            parentToolCallId,
            childSessionId,
            agentType: sessionArgs.agentType,
            ...(description !== undefined ? { description } : {}),
        });

        // executeSubagentSession never throws (errors are `{ isError: true }`),
        // so `.then` always fires with a result. `.catch` covers
        // formatBackgroundNotification / deliverSubagentResult, and still
        // delivers an error envelope so the parent is not left with a receipt
        // that never settles.
        let workAttemptId: string | undefined;
        const execute = async (attemptId?: string) => {
            workAttemptId = attemptId;
            if (sessionArgs.resume)
                return this.trackInFlight(parentSessionId, parentToolCallId, () =>
                    this.runResume({
                        parentSessionId,
                        parentToolCallId,
                        subSessionId: childSessionId,
                        prompt: sessionArgs.prompt,
                        signal: controller.signal,
                        onUpdate: sessionArgs.onUpdate,
                        newTask: true,
                        managedExternally: true,
                        budget: sessionArgs.budget,
                        abortController: controller,
                        executionId: runId,
                    }),
                );
            return this.executeSubagentSession({
                ...sessionArgs,
                childSessionId,
                executionId: runId,
                backgroundLifecycle: true,
                signal: controller.signal,
                abortController: controller,
            });
        };
        const execution =
            workId && this.workHooks?.run && sessionArgs.runtime !== "claude-code"
                ? this.workHooks.run(workId, childSessionId, execute)
                : execute();
        let settledResult: SubagentRunResult | undefined;
        const run = execution
            .then(async (result) => {
                settledResult = { ...result, aborted: controller.signal.aborted || result.aborted };
                this.conversation.settling(childSessionId);
                if (result.waiting) {
                    if (workId !== undefined)
                        await this.workHooks?.onWaiting?.(workId, result.waiting, workAttemptId);
                    return;
                }
                // The timeout and `abortSubagentRun` fire the same controller,
                // so an aborted run reads as "aborted" here regardless of
                // which one stopped it — a deliberate stop, not a failure.
                const outcome =
                    controller.signal.aborted || result.aborted
                        ? ("aborted" as const)
                        : result.isError
                          ? ("error" as const)
                          : ("completed" as const);
                const path = await this.writeBackgroundResult(resultPath, result.resultText);
                // Result and delivery intent land in one Work snapshot before
                // anything else observes the settle. A crash after this line
                // still leaves a record that someone must be told.
                if (workId !== undefined) {
                    await this.workHooks?.onSettle(workId, parentSessionId, {
                        attemptId: workAttemptId,
                        outcome,
                        resultText: result.resultText,
                        partial: result.partial === true,
                        ...(path !== undefined ? { path } : {}),
                    });
                }
                // Emitted before delivery, not after: delivery starts a fresh
                // parent run, and a consumer that keyed "this background child
                // is still running" off the launch receipt must be able to
                // clear that state before the new run's events arrive.
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome,
                });
                const notification = this.formatBackgroundNotification(sessionArgs.agentType, {
                    ...result,
                    outcome,
                    path,
                    description,
                });
                // Recorded before the attempt, so a delivery that never returns
                // (process killed mid-flight) still leaves a trace for the next
                // attach to flush. Cleared only once delivery actually lands.
                await this.recordPending({
                    workId,
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    agentType: sessionArgs.agentType,
                    outcome,
                    resultPath: path,
                    description,
                });
                // Only clear the pending record if the notice actually
                // reached the parent. A parent that is not currently attached
                // (process restarted, workspace disposed) returns `false`
                // here, not a throw — dropping the record in that case would
                // strand the notice forever: the record is the only thing
                // that makes `flushPendingSubagentResults` retry it on the
                // next attach.
                //
                // Caught locally, not left to the outer `.catch`: the pending
                // record above already has the *real* outcome and result
                // path (e.g. "completed" with `path` pointing at the file
                // that was just written). Reaching the outer `.catch` from
                // here would have it fabricate a fallback "failed, output
                // unavailable" notice for a run that actually succeeded —
                // strictly worse than the record already made, which flush
                // will retry delivery from.
                try {
                    const delivered = await this.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                    );
                    if (delivered) await this.dropPending(parentSessionId, parentToolCallId);
                } catch (e) {
                    log.error("background subagent delivery failed, will retry on next attach", {
                        parentSessionId,
                        parentToolCallId,
                        agentType: sessionArgs.agentType,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            })
            .catch(async (e) => {
                log.error("background subagent settling failed", {
                    parentSessionId,
                    parentToolCallId,
                    agentType: sessionArgs.agentType,
                    error: e instanceof Error ? e.message : String(e),
                });
                // Reaching here means the run itself, emitSettled, or
                // writeBackgroundResult threw before a pending record could
                // be made — delivery failures are now caught locally above
                // and never reach this branch. There is no result text or
                // path to report here, only that the task did not complete
                // normally. `emitSettled` is idempotent per parentToolCallId,
                // so this is safe even if it already fired for this spawn.
                if (workId !== undefined) {
                    // No-op when `.then` already settled it: the first terminal
                    // state wins, so this cannot rewrite a finished Work.
                    await this.workHooks?.onSettle(workId, parentSessionId, {
                        outcome: "error",
                        attemptId: workAttemptId,
                        resultText: e instanceof Error ? e.message : String(e),
                        partial: false,
                    });
                }
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome: "error",
                });
                const fallback = this.formatBackgroundNotification(sessionArgs.agentType, {
                    subSessionId: childSessionId,
                    resultText: e instanceof Error ? e.message : String(e),
                    outcome: "error",
                    description,
                });
                // recordPendingIfAbsent, not recordPending: guards against
                // this racing a `.then` recordPending call for the same
                // parentToolCallId — that record, if it exists, is always
                // at least as good as this fallback.
                await this.recordPendingIfAbsent({
                    workId,
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    agentType: sessionArgs.agentType,
                    outcome: "error",
                    description,
                });
                try {
                    const delivered = await this.deliverNotice(parentSessionId, fallback, workId);
                    if (delivered) await this.dropPending(parentSessionId, parentToolCallId);
                } catch (e2) {
                    log.error("background subagent fallback delivery failed", {
                        parentSessionId,
                        parentToolCallId,
                        error: e2 instanceof Error ? e2.message : String(e2),
                    });
                }
            })
            .finally(async () => {
                await this.conversation.end(childSessionId, runId, settledResult);
                clearTimeout(timer);
                this.backgroundInFlight.delete(parentToolCallId);
                this.backgroundRuns.delete(run);
                this.releaseController(childSessionId, controller);
                // Safe here, not in emitSettled: by the time this whole chain
                // settles, both the `.then` and `.catch` branches (the only
                // callers) have already run to completion, so no later call
                // for this same parentToolCallId can still be in flight to
                // race a fresh entry into existence. Without this the set
                // holds one string per background spawn for the process's
                // entire lifetime.
                this.settledEmitted.delete(`${parentToolCallId}:${runId}`);
            });
        // Deliberately not awaited or returned — see method doc. A rejection
        // from `run` is already handled by the `.catch` above, so there is no
        // unhandled-rejection risk in leaving it detached.
        //
        // Registered so the whole settle sequence — persist, record, deliver,
        // clear — has an observable end. Nothing in production waits on it, but
        // without a handle that sequence is only reachable by guessing how long
        // it takes, and it has already grown once (pending bookkeeping).
        this.backgroundRuns.add(run);
        void run;

        return {
            subSessionId: childSessionId,
            resultText: "",
            isError: false,
            background: true,
            resultPath,
        };
    }

    /**
     * Resolve once every in-flight background settle sequence has finished.
     *
     * Exists for callers that need the sequence's effects to be observable —
     * tests asserting on the pending record or the delivered notice, and any
     * future shutdown path that would rather drain than abandon. Not a
     * cancellation: a child still running is unaffected, this only waits for
     * children that already stopped to finish being written down.
     *
     * Re-reads the set after awaiting, because a settle can register follow-on
     * work; resolves when a pass adds nothing new.
     */
    async whenBackgroundRunsSettle(): Promise<void> {
        while (this.backgroundRuns.size > 0) {
            await Promise.allSettled([...this.backgroundRuns]);
        }
    }

    /**
     * Re-deliver notices this parent never received.
     *
     * Invoked on every `session.attached`. A session with nothing pending costs
     * one value read, which is why there is no "is this a parent" test — that
     * test would be a second source of truth about who can own pending entries.
     *
     * Delivery is sequential and each entry is cleared as it lands: a partial
     * flush (the parent goes busy halfway through) leaves the rest pending for
     * the next attach rather than dropping them.
     */
    private async flushPendingSubagentResults(
        parentSessionId: SessionId,
        trackedOnly = false,
    ): Promise<void> {
        if (this.flushingParents.has(parentSessionId)) return;
        this.flushingParents.add(parentSessionId);
        try {
            // Queued behind any in-flight recordPending/dropPending for this
            // parent, so this reads a consistent snapshot rather than racing
            // a concurrent settle's write.
            const pending = await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    readPendingSubagentResults(session),
                ),
            );
            const entries = Object.values(pending);
            if (entries.length === 0) return;
            log.info("flushing undelivered background subagent results", {
                parentSessionId,
                count: entries.length,
            });
            for (const entry of entries) {
                const workId =
                    entry.workId ??
                    this.workHooks?.workIdFor(
                        parentSessionId,
                        entry.parentToolCallId,
                        this.workspaceKey,
                    );
                const notification = this.formatBackgroundNotification(entry.agentType, {
                    subSessionId: entry.subSessionId,
                    resultText: "",
                    outcome: entry.outcome,
                    path: entry.resultPath,
                    description: entry.description,
                    late: true,
                });
                let delivered: boolean;
                try {
                    delivered = await this.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                        trackedOnly,
                        entry.workId !== undefined,
                        entry.workId === undefined
                            ? this.workHooks?.workIdFor(parentSessionId, entry.parentToolCallId)
                            : undefined,
                    );
                } catch (e) {
                    // Still unreachable. Keep the entry and stop: the remaining
                    // ones would fail the same way, and a tight retry loop
                    // against a busy parent buys nothing.
                    log.warn("pending subagent result still undeliverable", {
                        parentSessionId,
                        parentToolCallId: entry.parentToolCallId,
                        error: e instanceof Error ? e.message : String(e),
                    });
                    return;
                }
                // `false` (not a throw) means the parent still is not
                // attached — same "stop here, keep the rest pending" outcome
                // as the caught-exception branch above, just via the normal
                // return path instead of an error.
                if (!delivered) {
                    // Idle retries must not replay a legacy live notice whose
                    // pending entry is still waiting for dropPending to run.
                    if (trackedOnly) continue;
                    log.warn("pending subagent result still undeliverable: parent not attached", {
                        parentSessionId,
                        parentToolCallId: entry.parentToolCallId,
                    });
                    return;
                }
                await this.dropPending(parentSessionId, entry.parentToolCallId);
            }
        } catch (e) {
            log.error("failed to flush pending subagent results", {
                parentSessionId,
                error: e instanceof Error ? e.message : String(e),
            });
        } finally {
            this.flushingParents.delete(parentSessionId);
            if (this.deferredIdleFlushes.delete(parentSessionId))
                void this.flushPendingSubagentResults(parentSessionId, true);
        }
    }

    /**
     * Chain `run` onto this parent's pending-record queue and wait for it.
     *
     * `settled` swallows rejections so one failed link cannot poison the
     * queue for the next caller — the real result (and any throw) is still
     * awaited and surfaced below. Only the last-scheduled link clears the map
     * entry, or a queue still draining would lose its tail and let a later
     * caller run in parallel with an earlier one. Same shape as
     * `SessionRegistry.withSession`'s `detachedReads`.
     */
    private async withPendingQueue<T>(
        parentSessionId: SessionId,
        run: () => Promise<T>,
    ): Promise<T> {
        const previous = this.pendingWriteQueues.get(parentSessionId);
        const chained = (previous ?? Promise.resolve()).then(run);
        const settled = chained.then(
            () => undefined,
            () => undefined,
        );
        this.pendingWriteQueues.set(parentSessionId, settled);
        try {
            return await chained;
        } finally {
            if (this.pendingWriteQueues.get(parentSessionId) === settled) {
                this.pendingWriteQueues.delete(parentSessionId);
            }
        }
    }

    /**
     * Note a settled child whose notice has not been delivered yet.
     *
     * Bookkeeping must never be the reason a result is lost, so a failure here
     * is logged and swallowed: the delivery attempt that follows is the primary
     * path, and this only exists to make the retry possible if it fails.
     */
    private async recordPending(entry: {
        workId?: string;
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        runId?: string;
        agentType: string;
        outcome: "completed" | "error" | "aborted";
        resultPath?: string;
        description?: string;
    }): Promise<void> {
        const { parentSessionId, ...rest } = entry;
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    addPendingSubagentResult(session, { ...rest, settledAt: Date.now() }),
                ),
            );
        } catch (e) {
            log.error("failed to record pending subagent result", {
                parentSessionId,
                parentToolCallId: entry.parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Same as `recordPending`, but only writes when no record for this
     * `parentToolCallId` exists yet.
     *
     * Used by the `.catch` fallback path: reaching there after
     * `deliverSubagentResult` itself threw means the `.then` branch already
     * wrote the real outcome before the throw, and this must not clobber it
     * with a worse one. The read-then-write is inside `withPendingQueue` so
     * it cannot race the `.then` branch's own `recordPending` for the same
     * parent.
     */
    private async recordPendingIfAbsent(entry: {
        workId?: string;
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        runId?: string;
        agentType: string;
        outcome: "completed" | "error" | "aborted";
        resultPath?: string;
        description?: string;
    }): Promise<void> {
        const { parentSessionId, ...rest } = entry;
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, async (session) => {
                    const existing = await readPendingSubagentResults(session);
                    if (entry.parentToolCallId in existing) return;
                    await addPendingSubagentResult(session, { ...rest, settledAt: Date.now() });
                }),
            );
        } catch (e) {
            log.error("failed to record pending subagent result", {
                parentSessionId,
                parentToolCallId: entry.parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /** Clear a pending notice after it was delivered. Failures are logged, not raised. */
    private async dropPending(parentSessionId: SessionId, parentToolCallId: string): Promise<void> {
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    clearPendingSubagentResult(session, parentToolCallId),
                ),
            );
        } catch (e) {
            log.error("failed to clear pending subagent result", {
                parentSessionId,
                parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Emit `subagent.settled` once per background spawn.
     *
     * Both the success and the failure path call this, so it deduplicates on
     * `parentToolCallId` — a consumer that treats the event as "clear the
     * running marker" must not see a second one after the marker is gone and
     * a *new* spawn has reused nothing (ids are unique per tool call, so the
     * dedupe set only ever suppresses a genuine double-emit).
     */
    private emitSettled(
        agentType: string,
        args: {
            parentSessionId: SessionId;
            parentToolCallId: string;
            subSessionId: SessionId;
            runId?: string;
            outcome: "completed" | "error" | "aborted";
        },
    ): void {
        const key = `${args.parentToolCallId}:${args.runId ?? "legacy"}`;
        if (this.settledEmitted.has(key)) return;
        this.settledEmitted.add(key);
        const chatRunId = args.parentToolCallId.startsWith("chat:")
            ? args.parentToolCallId.slice(5)
            : undefined;
        if (chatRunId && this.chatRuns.has(chatRunId)) {
            this.settleChatRun(chatRunId, args.outcome);
            return;
        }
        this.emit("subagent.settled", {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            subSessionId: args.subSessionId,
            agentType,
            ...(args.runId !== undefined ? { runId: args.runId } : {}),
            outcome: args.outcome,
        });
    }

    /**
     * Persist a background subagent's result text and return its path.
     *
     * Returns `undefined` when the write fails: a lost file degrades the
     * notification to "it finished, outcome X, text unavailable", which is
     * strictly better than dropping the notification altogether and leaving
     * the parent waiting on a child that already stopped.
     */
    private async writeBackgroundResult(
        path: string,
        resultText: string,
    ): Promise<string | undefined> {
        try {
            await mkdir(dirname(path), { recursive: true });
            // Published by rename: the parent reads this file as the child's
            // only answer, so a crash mid-write must not truncate it.
            await writeTextAtomic(path, resultText);
            return path;
        } catch (e) {
            log.error("failed to persist background subagent result", {
                path,
                error: e instanceof Error ? e.message : String(e),
            });
            return undefined;
        }
    }

    /**
     * Hand a settled notice to the parent and report whether it landed.
     *
     * With a Work attached, the notice run's reply is held back from the
     * channel and captured as the message to send. That is what makes the
     * outcome reliable: the reply is stored with the Work and delivered by
     * the Work deliverer, instead of leaving through a push that only logs a
     * failure.
     */
    private async deliverNotice(
        parentSessionId: SessionId,
        notification: string,
        workId: string | undefined,
        trackedOnly = false,
        tracked = true,
        legacyWorkId?: string,
    ): Promise<boolean> {
        const hooks = this.workHooks;
        if (!hooks || workId === undefined)
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        const decision = await hooks.beginParentNotice(
            workId,
            tracked,
            { workspace: this.workspaceKey, sessionId: parentSessionId },
            legacyWorkId,
        );
        if (decision.mode === "skip") return !decision.retry;
        if (decision.mode === "legacy") {
            if (trackedOnly) return false;
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        }
        workId = decision.workId ?? workId;

        let held = false;
        let ran = false;
        let reply: string | undefined;
        const release = (): void => {
            if (!held) return;
            held = false;
            hooks.onNoticeRunRelease(workId, parentSessionId);
        };
        try {
            const run = () =>
                deliverSubagentResultDetailed(this.sessionRegistry, parentSessionId, notification, {
                    enqueueWhenBusy: false,
                    beforePrompt: () => {
                        hooks.onNoticeRunStart(workId, parentSessionId, this.workspaceKey);
                        held = true;
                    },
                    afterPrompt: (text, didRun) => {
                        ran = didRun;
                        reply = text;
                        if (!didRun) release();
                    },
                });
            const outcome = hooks.runParentNotice
                ? await hooks.runParentNotice(workId, decision.claimId, parentSessionId, run)
                : await run();
            return outcome === "replied";
        } finally {
            try {
                await hooks.endParentNotice(workId, decision.claimId, {
                    status: ran ? "completed" : "not_run",
                    ...(reply === undefined ? {} : { reply }),
                });
            } finally {
                release();
            }
        }
    }

    /**
     * Envelope injected into the parent session once a background subagent
     * settles.
     *
     * Carries a *pointer*, not the answer: the result text is on disk, so the
     * parent's context pays for a path instead of an arbitrarily long transcript
     * it may never need. The `subagent_result` tag is registered `hidden`, so
     * none of this reaches the user's chat — which is why the body can afford to
     * spell out what the model should do next, including asking it to open with
     * a sentence acknowledging the result. Without that, the conversation would
     * jump straight from unrelated work to a background finding with no bridge.
     */
    private formatBackgroundNotification(
        agentType: string,
        result: {
            subSessionId: SessionId;
            resultText: string;
            outcome: "completed" | "error" | "aborted";
            path?: string;
            /**
             * The task label from the original `agent` call. Repeated here
             * because the notice can land many turns later: the conversation has
             * moved on, and a compaction in between may have collapsed the tool
             * call that would otherwise say what this subagent was for.
             */
            description?: string;
            /**
             * Re-delivery of a notice the parent missed while unreachable. Said
             * out loud because the model may have already told the user this
             * subagent was still running, and it needs to correct that rather
             * than present stale news as fresh.
             */
            late?: boolean;
        },
    ): string {
        const status = result.outcome;
        const located = result.path
            ? `Its full output is saved at: ${result.path}\nThat text is NOT included here — the file is the only copy.`
            : "Its output could not be saved to disk, so the detail is unavailable. Say so rather than guessing at it.";
        const guidance =
            result.outcome === "aborted"
                ? "This task was stopped deliberately — by the user or by its own time limit. Tell the user in one sentence that it was stopped, and do not restart or respawn it unless they ask."
                : result.outcome === "error"
                  ? "Read that file before replying: it holds the error and, if the subagent got partway, how far it got and whether it can be resumed. Then tell the user in one sentence that this background task failed, and propose a next step based on what you read. Do not present its output as a result."
                  : "Read that file with the read tool now, before you reply. Then tell the user, in your own words, that this background task came back and what it found — do not just hand them the path, and do not claim it is still running. If what you read changes what you were doing, say so.";
        const lateness = result.late
            ? " This notice is late — it could not be delivered when the subagent actually" +
              " finished, so if you previously told the user it was still running, correct that."
            : "";
        // In the body, not an attribute: `tagWrap` escapes attribute values but
        // not the body, and this is the one part of the envelope that is
        // model-authored text. The body is safe because the balanced parser does
        // not nest — a forged tag inside it stays inside it.
        const task = result.description ? `\nIts task was: ${result.description}` : "";
        return tagWrap(
            "subagent_result",
            `The ${agentType} subagent you launched in the background has finished (outcome: ${status}).` +
                `${lateness}${task}\n` +
                `${located}\n\n` +
                guidance,
            {
                "agent-type": agentType,
                session: result.subSessionId,
                outcome: status,
                ...(result.path ? { path: result.path } : {}),
                ...(result.late ? { late: "true" } : {}),
            },
        );
    }

    /**
     * Reads the child session's current branch and returns the concatenated
     * text of the last assistant message, with an explicit empty flag so an
     * empty reply is distinguishable from a reply that happens to contain the
     * word "(empty response)".
     *
     * findEntriesOnBranch() (not findEntries()) anchors to the current leaf — findEntries
     * returns the whole append log, which would surface text from a forked-off
     * branch if the session ever gets one.
     */
    private async extractLastAssistantText(
        sessionId: SessionId,
    ): Promise<{ text: string; isEmpty: boolean }> {
        const entries = await this.sessionRegistry.withSession(sessionId, (session) =>
            findBranchEntries(session),
        );
        let latestAssistantText = "";
        for (const entry of entries) {
            if (entry.type !== "message") continue;
            const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
            if (msg?.role !== "assistant") continue;
            const content = msg.content;
            if (!Array.isArray(content)) continue;
            const textParts: string[] = [];
            for (const part of content) {
                if (
                    part &&
                    typeof part === "object" &&
                    (part as { type?: string }).type === "text"
                ) {
                    const txt = (part as { text?: unknown }).text;
                    if (typeof txt === "string") textParts.push(txt);
                }
            }
            if (textParts.length > 0) latestAssistantText = textParts.join("\n");
        }
        return latestAssistantText === ""
            ? { text: "", isEmpty: true }
            : { text: latestAssistantText, isEmpty: false };
    }

    activeSubagentChatRuns(parentSessionId: SessionId) {
        return [...this.chatRuns.values()].filter((run) => run.parentSessionId === parentSessionId);
    }

    private settleChatRun(runId: string, outcome: "completed" | "error" | "aborted"): void {
        const run = this.chatRuns.get(runId);
        if (!run) return;
        this.chatRuns.delete(runId);
        this.emit("subagent.settled", { ...run, outcome });
    }

    async dispose(): Promise<void> {
        for (const { controller } of this.subagentControllers.values()) controller.abort();
        await this.conversation.dispose();
        await this.whenBackgroundRunsSettle();
        this.removeAllListeners();
    }

    chatToAgent(callerSessionId: SessionId, args: AgentChatArgs): Promise<AgentChatResult> {
        return this.conversation.chat(callerSessionId, args);
    }

    listAgentSessions(callerSessionId: SessionId) {
        return this.conversation.list(callerSessionId);
    }

    private async startConversationRun(message: AgentMessageRecord, args: AgentChatArgs) {
        const facts = await this.sessionRegistry.withSession(
            message.targetSessionId,
            readSessionFacts,
        );
        const def = facts.agentType ? this.findAgent(facts.agentType) : undefined;
        if (!def)
            throw new Error(
                "The original agent profile is unavailable; create a new agent explicitly.",
            );
        if ((facts.runtime ?? "standard") !== (def.runtime ?? "standard")) {
            throw new Error(
                "The agent profile changed execution engine; the existing conversation cannot switch engines.",
            );
        }
        if (
            facts.runtime === "claude-code" &&
            !(await this.sessionRegistry.withSession(message.targetSessionId, readClaudeCodeState))
        ) {
            throw new Error(
                "This Claude Code session cannot be resumed because it has no saved native session. Create a fresh agent explicitly.",
            );
        }
        if (facts.runtime === "codex") {
            if (
                !(await this.sessionRegistry.withSession(message.targetSessionId, readCodexState))
            ) {
                throw new Error(
                    "This Codex session cannot be resumed because its native thread mapping was not saved. Create a fresh agent explicitly.",
                );
            }
            await this.preflightCodexRuntime();
        }
        const runId = uuidv7();
        const started = {
            parentSessionId: message.ownerParentSessionId,
            parentToolCallId: facts.parentToolCallId ?? args.parentToolCallId,
            subSessionId: message.targetSessionId,
            agentType: def.agentType,
            runId,
            messageId: message.messageId,
        };
        const announce = () => {
            this.chatRuns.set(runId, started);
            this.emit("subagent.started", started);
        };
        const prompt = message.queueEntryId
            ? `Process the queued agent message ${message.messageId}. Its content is in the native message queue.`
            : agentMessageEnvelope(message);
        const receipt: AgentChatResult = {
            subSessionId: message.targetSessionId,
            messageId: message.messageId,
            runId,
            status: "started",
            effectiveDelivery:
                facts.runtime === "claude-code"
                    ? "nextTurn"
                    : facts.runtime === "codex"
                      ? "followUp"
                      : message.delivery,
            resultText:
                "The existing agent conversation is continuing. Completion will be reported to its original parent.",
            isError: false,
        };
        if (message.background) {
            if (this.backgroundInFlight.size >= MAX_CONCURRENT_BACKGROUND_SUBAGENTS)
                throw new Error("Too many background subagents already running.");
            const parentToolCallId = `chat:${runId}`;
            this.backgroundInFlight.add(parentToolCallId);
            announce();
            const launched = await this.spawnBackgroundSubagent(
                {
                    parentSessionId: message.ownerParentSessionId,
                    parentToolCallId,
                    childSessionId: message.targetSessionId,
                    executionId: runId,
                    resume: true,
                    agentType: def.agentType,
                    prompt,
                    tools: [],
                    runtime: facts.runtime,
                    budget: {
                        turnsUsed: 0,
                        startedAt: Date.now(),
                        ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
                    },
                },
                def,
                message.prompt.slice(0, 160),
            );
            return { result: { ...receipt, resultPath: launched.resultPath } };
        }
        const executionController = facts.runtime === "codex" ? new AbortController() : undefined;
        const followChatAbort = (): void => executionController?.abort(args.signal?.reason);
        if (executionController) {
            if (args.signal?.aborted) executionController.abort(args.signal.reason);
            args.signal?.addEventListener("abort", followChatAbort, { once: true });
            this.subagentControllers.set(message.targetSessionId, {
                controller: executionController,
                parentSessionId: message.ownerParentSessionId,
            });
        }
        announce();
        this.conversation.begin(message.targetSessionId, {
            runId,
            parentSessionId: message.ownerParentSessionId,
            runtime: facts.runtime,
            phase: "preparing",
        });
        const completion = this.trackInFlight(
            message.ownerParentSessionId,
            args.parentToolCallId,
            () =>
                this.runResume({
                    parentSessionId: message.ownerParentSessionId,
                    parentToolCallId: args.parentToolCallId,
                    subSessionId: message.targetSessionId,
                    prompt,
                    signal: args.signal,
                    onUpdate: args.onUpdate,
                    newTask: true,
                    managedExternally: true,
                    executionId: runId,
                    ...(executionController ? { abortController: executionController } : {}),
                }),
        )
            .then(
                async (result) => {
                    this.settleChatRun(
                        runId,
                        result.aborted ? "aborted" : result.isError ? "error" : "completed",
                    );
                    await this.conversation.end(message.targetSessionId, runId, result);
                    return {
                        ...receipt,
                        status: result.aborted
                            ? ("aborted" as const)
                            : result.isError
                              ? ("error" as const)
                              : ("completed" as const),
                        resultText: result.resultText,
                        isError: result.isError && !result.aborted,
                    };
                },
                async (error: unknown) => {
                    const result = {
                        subSessionId: message.targetSessionId,
                        resultText: String(error),
                        isError: true,
                    };
                    this.settleChatRun(runId, "error");
                    await this.conversation.end(message.targetSessionId, runId, result);
                    return {
                        ...receipt,
                        status: "error" as const,
                        resultText: String(error),
                        isError: true,
                    };
                },
            )
            .finally(() => {
                args.signal?.removeEventListener("abort", followChatAbort);
                if (executionController) {
                    this.releaseController(message.targetSessionId, executionController);
                }
            });
        return { result: receipt, completion };
    }

    /**
     * Resume an existing subagent by `subSessionId`. The caller MUST be the
     * same parent session that originally spawned it (verified via JSONL
     * metadata). Concurrent calls with the same `subSessionId` share the
     * single in-flight result.
     *
     * Re-applies the original agentType's role body + few-shots to the
     * rebuilt system prompt, and subtracts already-consumed assistant
     * messages from `maxTurns` so the turn cap continues across resumes.
     */
    async resumeSubagent(args: {
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        prompt: string;
        signal?: AbortSignal;
        onUpdate?: SubagentProgressSink;
    }): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        aborted?: boolean;
    }> {
        let runtime: SubagentRuntime | undefined;
        try {
            const facts = await this.sessionRegistry.withSession(
                args.subSessionId,
                readSessionFacts,
            );
            runtime = facts.runtime;
            if (facts.kind !== "subagent")
                return {
                    subSessionId: args.subSessionId,
                    resultText: `cannot continue: session ${args.subSessionId} is not a subagent`,
                    isError: true,
                };
            if (facts.parentSessionId !== args.parentSessionId)
                return {
                    subSessionId: args.subSessionId,
                    resultText: "cannot continue: subagent belongs to a different parent session",
                    isError: true,
                };
        } catch (error) {
            return {
                subSessionId: args.subSessionId,
                resultText: error instanceof Error ? error.message : String(error),
                isError: true,
            };
        }
        // Single-flight: a second concurrent call with the same subSessionId
        // reuses the in-flight promise rather than racing to re-attach and
        // interleave user messages on the same branch. The cache entry is
        // removed on settle so a later resume gets a fresh run.
        const existing = this.resumeInFlight.get(args.subSessionId);
        if (existing) return existing;
        // The single-flight entry is dropped *inside* the in-flight tracking, not
        // around it: releasing the tracking first would leave a window where the
        // cache still hands this promise to a concurrent caller while `inFlight`
        // already reports the run as finished — an attach in that window would see
        // a live subagent as an orphan.
        if (this.conversation.state(args.subSessionId))
            return {
                subSessionId: args.subSessionId,
                isError: true,
                resultText:
                    "This agent is already running. Send additional instructions with chatToAgent instead.",
            };
        const runId = uuidv7();
        this.conversation.begin(args.subSessionId, {
            runId,
            parentSessionId: args.parentSessionId,
            runtime,
            phase: "preparing",
        });
        let result: SubagentRunResult | undefined;
        const promise = this.trackInFlight(
            args.parentSessionId,
            args.parentToolCallId,
            async () => {
                try {
                    result = await this.runResume({ ...args, executionId: runId });
                    return result;
                } finally {
                    await this.conversation.end(args.subSessionId, runId, result);
                    this.resumeInFlight.delete(args.subSessionId);
                }
            },
        );
        this.resumeInFlight.set(args.subSessionId, promise);
        return promise;
    }

    /**
     * Tell the Work layer a resumed run is beginning. Never throws: Work
     * tracking is additive, and a store failure must not stop the resume.
     */
    private async reportResumeStart(
        subSessionId: SessionId,
    ): Promise<WorkAttemptHandle | undefined> {
        try {
            return (
                (await this.workHooks?.onResumeStart(subSessionId, this.workspaceKey)) ?? undefined
            );
        } catch (e) {
            log.warn("work resume start record failed", {
                subSessionId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /** Close the reopened Work with the resumed run's outcome. Never throws. */
    private async reportResumeSettle(
        subSessionId: SessionId,
        result: SubagentRunResult,
        handle?: WorkAttemptHandle,
    ): Promise<void> {
        if (!this.workHooks) return;
        try {
            await this.workHooks.onResumeSettle(
                subSessionId,
                {
                    outcome: result.isError ? (result.aborted ? "aborted" : "error") : "completed",
                    resultText: result.resultText,
                    partial: result.partial === true,
                    ...(result.waiting ? { waiting: result.waiting } : {}),
                },
                handle,
            );
        } catch (e) {
            log.warn("work resume settle record failed", {
                subSessionId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    private runResume(args: ResumeSubagentArgs): Promise<SubagentRunResult> {
        return runSubagentResume(args, {
            registry: this.sessionRegistry,
            findAgent: (name) => this.findAgent(name),
            getTools: this.getTools,
            childAttachDeps: this.childAttachDeps,
            defaultModelIdentity: this.defaultModelIdentity,
            workHooks: this.workHooks,
            countAssistantTurns: (id) => this.countAssistantTurns(id),
            readLastAssistantText: (id) => this.extractLastAssistantText(id),
            reportResumeStart: (id) => this.reportResumeStart(id),
            reportResumeSettle: (id, result, handle) => this.reportResumeSettle(id, result, handle),
            registerController: (id, controller, parentSessionId) =>
                this.subagentControllers.set(id, { controller, parentSessionId }),
            releaseController: (id, controller) => this.releaseController(id, controller),
            runClaudeCode: (request, def) =>
                this.runClaudeCodeChild(request.subSessionId, {
                    parentSessionId: request.parentSessionId,
                    parentToolCallId: request.parentToolCallId,
                    agentType: def.agentType,
                    prompt: request.prompt,
                    tools: [],
                    runtime: "claude-code",
                    resume: true,
                    rolePrompt: def.systemPrompt,
                    maxTurns: def.maxTurns,
                    claudeCodeTools: def.tools,
                    permissionMode: def.permissionMode,
                    claudeCodeCwd: def.cwd,
                    signal: request.signal,
                    onUpdate: request.onUpdate,
                }),
            runCodex: (request, def, controller) =>
                this.runCodexChild(request.subSessionId, {
                    parentSessionId: request.parentSessionId,
                    parentToolCallId: request.parentToolCallId,
                    agentType: def.agentType,
                    prompt: request.prompt,
                    tools: [],
                    runtime: "codex",
                    resume: true,
                    rolePrompt: def.systemPrompt,
                    ...(def.codex !== undefined ? { codexConfig: def.codex } : {}),
                    ...(def.tools !== undefined ? { codexTools: def.tools } : {}),
                    abortController: controller,
                    signal: request.signal,
                    onUpdate: request.onUpdate,
                }),
        });
    }

    /**
     * Count completed assistant turns on a session's current branch. Used to
     * subtract already-consumed turns from `maxTurns` so the cap survives
     * across resumes. Reads `findEntriesOnBranch()` (current leaf, not full append log)
     * so a forked-off branch cannot inflate the count.
     */
    private async countAssistantTurns(sessionId: SessionId): Promise<number> {
        try {
            const entries = await this.sessionRegistry.withSession(sessionId, (session) =>
                findBranchEntries(session),
            );
            let n = 0;
            for (const entry of entries) {
                if (entry.type !== "message") continue;
                const msg = (entry as { message?: { role?: string } }).message;
                if (msg?.role === "assistant") n++;
            }
            return n;
        } catch {
            // If we cannot read the branch (corrupt jsonl, missing file),
            // assume no turns consumed so the resume gets the full budget
            // rather than zero — a degraded but safe default.
            return 0;
        }
    }

    // ─────────── skill subagent ─────────────────────────────────────────────────

    /**
     * SkillTool subagent entry: validates the frontmatter runAs decision, then delegates to
     * runSkillSubagent. Skill content + frontmatter are pre-read by the caller (SkillTool),
     * so this layer does no I/O. Never throws — errors are wrapped in { isError: true }.
     *
     * `inlineOnly` is a second-line guard: SkillTool already rejects inlineOnly skills in
     * subagent mode, but a future caller (extension, hook) could reach this path directly.
     * Fail closed here so the constraint holds regardless of who calls in.
     */
    spawnSkillSubagent(opts: SpawnSkillSubagentOptions): Promise<{
        subSessionId?: string;
        resultText: string;
        isError: boolean;
    }> {
        if (opts.skillFrontmatter.inlineOnly === true) {
            // No child session created — leave subSessionId off entirely.
            return Promise.resolve({
                resultText: `skill "${opts.skillName}" is inline-only and cannot run as a subagent. Invoke it from the main session via the inline path instead.`,
                isError: true,
            });
        }
        if (opts.skillFrontmatter.runAs !== "subagent") {
            const actual = opts.skillFrontmatter.runAs ?? "inline";
            return Promise.resolve({
                resultText: `skill frontmatter has runAs="${actual}", not "subagent". Use a subagent-frontmattered skill instead.`,
                isError: true,
            });
        }

        return this.runSkillSubagent({
            parentSessionId: asSessionId(opts.parentSessionId),
            parentToolCallId: opts.parentToolCallId,
            skillName: opts.skillName,
            skillContent: opts.skillContent,
            args: opts.args,
            allowedTools: opts.skillFrontmatter.allowedTools,
            model: opts.skillFrontmatter.model,
            signal: opts.signal,
            onUpdate: opts.onUpdate,
        });
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
        onUpdate?: SubagentProgressSink;
    }): Promise<{ subSessionId?: string; resultText: string; isError: boolean }> {
        const pid = args.parentSessionId;
        if (!pid) {
            return {
                resultText: "skill subagent requires a parent session",
                isError: true,
            };
        }

        const agentType = `skill:${args.skillName}`;
        const userPrompt = interpolateArgs(args.skillContent, args.args);
        const modelOverride: Model<Api> | undefined = args.model
            ? findModelById(this.models, args.model)
            : undefined;

        // Resolve child depth BEFORE tool filtering — filterToolsForAgent removes the
        // parent "agent" tool when depth>=1, and we must not let a skill subagent
        // recursively spawn grandchildren (which would let it call Skill again and
        // explode tokens / loop). Computing here also avoids a second openSession()
        // call inside executeSubagentSession.
        const parentFacts = await this.sessionRegistry.withSession(pid, (session) =>
            readSessionFacts(session),
        );
        const parentDepth = resolveParentDepth(parentFacts, {
            parentSessionId: pid,
            skillName: args.skillName,
        });
        const childDepth = parentDepth + 1;

        const allowedSet = args.allowedTools ? new Set(args.allowedTools) : undefined;
        const filtered = filterToolsForAgent(
            this.getTools(),
            allowedSet ? [...allowedSet] : undefined,
            childDepth,
        );
        const childTools = filtered.filter((t) => t.name !== "skill");

        return this.executeSubagentSession({
            parentSessionId: pid,
            parentToolCallId: args.parentToolCallId,
            agentType,
            prompt: userPrompt,
            tools: childTools,
            model: modelOverride,
            signal: args.signal,
            onUpdate: args.onUpdate,
            // `skill:<name>` is not an agent-registry type, so chatToAgent
            // cannot resume this child — say so rather than defaulting silently.
            resumability: "not_resumable",
            childDepth,
            // A skill's allowedTools list bounds what it may load on demand,
            // the same way a profile's `tools:` list does.
            toolPolicy: agentToolPolicy(allowedSet ? [...allowedSet] : undefined, childDepth),
        });
    }
}
