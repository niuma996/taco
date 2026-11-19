/**
 * AgentSpawner — subagent creation and execution: validates the agentType,
 * narrows the toolset, then drives the child to completion.
 *
 * Engine adapters own execution details; SubagentRunLifecycle owns cancellation
 * scopes. The facade assembles spawn, background delivery and conversation coordinators.
 */

import { EventEmitter } from "node:events";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import { agentToolPolicy, filterToolsForAgent } from "../../agents/filterTools.ts";
import type {
    AgentDefinition,
    SubagentContextMode,
    SubagentProgressSink,
    SubagentRuntime,
} from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import type { SystemPromptContributor } from "../../prompts/buildSystemPrompt.ts";
import type { DeferredToolCatalogEntry } from "../../prompts/formatCatalogForSystemPrompt.ts";
import type { EnvironmentContext } from "../../prompts/index.ts";
import { interpolateArgs } from "../../skills/skillMessages.ts";
import type { SpawnSkillSubagentOptions } from "../../skills/skillTool.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { BackgroundWorkHooks } from "../../work/workHooks.ts";
import type { WorkAttemptHandle } from "../../work/workOperationTypes.ts";
import { findModelById } from "../models/modelLookup.ts";
import type { NodeExecutionEnv } from "../pi/node.ts";
import type { Api, Model, MutableModels } from "../pi/types.ts";
import { uuidv7 } from "../pi/values.ts";
import { findBranchEntries } from "../session/sessionBranch.ts";
import { readSessionFacts, resolveParentDepth } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { AgentMessageRecord } from "./agentConversation.ts";
import { AgentConversationRunner } from "./agentConversationRunner.ts";
import { AgentConversationRuntime } from "./agentConversationRuntime.ts";
import {
    BackgroundSubagentCoordinator,
    MAX_CONCURRENT_BACKGROUND_SUBAGENTS,
} from "./backgroundSubagentCoordinator.ts";
import type { ChildAttachDeps } from "./childAttach.ts";
import { findClaudeExecutable, loadClaudeAgentSdk } from "./claudeCode/claudeCodeSdk.ts";
import { loadCodexSdk } from "./codex/codexSdk.ts";
import { createClaudeCodeEngine } from "./engines/claudeCodeEngine.ts";
import { createCodexEngine } from "./engines/codexEngine.ts";
import { normalizeSubagentRuntime } from "./engines/runtime.ts";
import { createStandardEngine } from "./engines/standardEngine.ts";
import type { AgentEngine, NativeEngineDeps } from "./engines/types.ts";
import type { SubagentExecution } from "./subagentCoordination.ts";
import { type ResumeSubagentArgs, runSubagentResume } from "./subagentResume.ts";
import { SubagentRunLifecycle } from "./subagentRunLifecycle.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";
import { SubagentSpawnCoordinator } from "./subagentSpawnCoordinator.ts";
import type { SubagentSessionArgs } from "./subagentTypes.ts";

export { backgroundTimeoutMs } from "./backgroundSubagentCoordinator.ts";

const log = createLogger("sidecar.agentSpawner");

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
export type { SubagentSessionArgs } from "./subagentTypes.ts";

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
    private readonly background: BackgroundSubagentCoordinator;
    private readonly spawnCoordinator: SubagentSpawnCoordinator;
    private readonly conversationRunner: AgentConversationRunner;
    private readonly engines: Record<SubagentRuntime, AgentEngine>;
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
        this.runLifecycle = new SubagentRunLifecycle();
        this.conversation = new AgentConversationRuntime({
            registry: this.sessionRegistry,
            findAgent: (name) => this.findAgent(name),
            start: (message, args) => this.startConversationRun(message, args),
        });
        const nativeDeps: NativeEngineDeps = {
            registry: this.sessionRegistry,
            executionCwd: () => this.env.cwd,
            conversation: {
                setInput: (id, input) => this.conversation.setInput(id, input),
                markRunning: (id, runId) => this.conversation.markRunning(id, runId),
                chat: (id, args) => this.chatToAgent(id, args),
                list: (id) => this.listAgentSessions(id),
            },
            appendMessages: (id, messages) =>
                this.spawnCoordinator.appendChildMessages(id, messages),
        };
        this.engines = {
            standard: createStandardEngine({
                registry: this.sessionRegistry,
                childAttachDeps: () => this.childAttachDeps,
                defaultModelIdentity: () => this.defaultModelIdentity,
                readLastAssistantText: (id) => this.extractLastAssistantText(id),
            }),
            "claude-code": createClaudeCodeEngine({
                ...nativeDeps,
                getAllowedCwds: () => this.getAllowedCwds(),
                loadClaudeCodeSdk: () => this.loadClaudeCodeSdk(),
                findClaudeCode: () => this.findClaudeCode(),
            }),
            codex: createCodexEngine({
                ...nativeDeps,
                getAllowedCwds: () => this.getAllowedCwds(),
                loadCodexSdkForRun: () => this.loadCodexSdkForRun(),
            }),
        };
        const execution: SubagentExecution = {
            execute: (args) => this.executeSubagentSession(args),
            resume: (args) => this.runResume(args),
            track: (parent, call, run) => this.trackInFlight(parent, call, run),
        };
        this.spawnCoordinator = new SubagentSpawnCoordinator({
            sessionRegistry: this.sessionRegistry,
            conversation: this.conversation,
            runLifecycle: this.runLifecycle,
            engines: this.engines,
            execution,
            events: {
                emit: (event, payload) => {
                    this.emit(event, payload);
                },
            },
            getTools: () => this.getTools(),
            background: {
                launch: (args, def, description) => this.background.launch(args, def, description),
            },
        });
        this.background = new BackgroundSubagentCoordinator({
            sessionRegistry: this.sessionRegistry,
            conversation: this.conversation,
            runLifecycle: this.runLifecycle,
            engines: this.engines,
            workHooks: this.workHooks,
            sessionsRoot: this.sessionsRoot,
            workspaceKey: this.workspaceKey,
            execution,
            events: {
                emit: (event, payload) => {
                    this.emit(event, payload);
                },
                settleChat: (id, outcome) => {
                    if (!this.chatRuns.has(id)) return false;
                    this.settleChatRun(id, outcome);
                    return true;
                },
            },
        });
        this.conversationRunner = new AgentConversationRunner({
            sessionRegistry: this.sessionRegistry,
            conversation: this.conversation,
            engines: this.engines,
            background: this.background,
            runLifecycle: this.runLifecycle,
            execution,
            findAgent: (type) => this.findAgent(type),
            events: {
                announce: (started) => {
                    this.chatRuns.set(started.runId, started);
                    this.emit("subagent.started", started);
                },
                settle: (runId, outcome) => this.settleChatRun(runId, outcome),
            },
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

    /** Scopes retain cancellation through setup, execution and background settlement. */
    private readonly runLifecycle: SubagentRunLifecycle;

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
        return this.runLifecycle.stopChildrenOf(parentSessionId, timeoutMs);
    }

    /** Looks up a subagent definition in the registry by `agentType`. */
    findAgent(type: string): AgentDefinition | undefined {
        return this.agents.find((a) => a.agentType === type);
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
        return this.runLifecycle.abort(subSessionId, forParentSessionId);
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
        return this.spawnCoordinator.executeSubagentSession(args);
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
        failurePhase?: SubagentRunResult["failurePhase"];
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
        try {
            await this.engines[normalizeSubagentRuntime(def.runtime)].preflight(def);
        } catch (error) {
            return {
                resultText: error instanceof Error ? error.message : String(error),
                isError: true,
                ...(args.background ? { background: true as const } : {}),
            };
        }
        // Reserve the background slot before any `await` so two concurrent
        // launches cannot both pass a stale `size` check. Released in
        // `spawnBackgroundSubagent`'s `.finally`, or here if we bail before
        // that run is kicked off. Duplicate `parentToolCallId` is a retry of
        // the same tool call, not a second spawn — reject rather than count
        // twice and delete once.
        if (args.background) {
            const reservation = this.background.reserve(args.parentToolCallId);
            if (reservation === "duplicate") {
                return {
                    resultText:
                        "a background subagent for this tool call is already running; " +
                        "wait for it to finish instead of launching a duplicate.",
                    isError: true,
                    background: true,
                };
            }
            if (reservation === "full") {
                return {
                    resultText:
                        "too many background subagents already running " +
                        `(limit ${MAX_CONCURRENT_BACKGROUND_SUBAGENTS}). Wait for one to finish, or run this ` +
                        "one synchronously instead.",
                    isError: true,
                    background: true,
                };
            }
        }
        try {
            return await this.spawnCoordinator.prepareAndRunSpawn(args, def);
        } catch (e) {
            if (args.background) this.background.release(args.parentToolCallId);
            return {
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
                ...(args.background ? { background: true as const } : {}),
            };
        }
    }
    /** Retry undelivered child results after a parent reconnect or idle transition. */
    flushPendingSubagentResults(parentSessionId: SessionId, trackedOnly = false): Promise<void> {
        return this.background.flush(parentSessionId, trackedOnly);
    }

    async whenBackgroundRunsSettle(): Promise<void> {
        await this.background.whenBackgroundRunsSettle();
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
        this.conversation.stopAccepting();
        this.runLifecycle.stop();
        await this.conversation.whenExecutionsSettle();
        await this.whenBackgroundRunsSettle();
        this.background.dispose();
        await this.conversation.dispose();
        this.removeAllListeners();
    }

    chatToAgent(callerSessionId: SessionId, args: AgentChatArgs): Promise<AgentChatResult> {
        return this.conversation.chat(callerSessionId, args);
    }

    listAgentSessions(callerSessionId: SessionId) {
        return this.conversation.list(callerSessionId);
    }

    private startConversationRun(message: AgentMessageRecord, args: AgentChatArgs) {
        return this.conversationRunner.start(message, args);
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
            countAssistantTurns: (id) => this.countAssistantTurns(id),
            execute: (request, managedExternally, definition) =>
                this.runResumedEngine(request, managedExternally, definition),
        });
    }

    private runResumedEngine(
        args: SubagentSessionArgs & { childSessionId: SessionId },
        managedExternally: boolean,
        definition: AgentDefinition,
    ): Promise<SubagentRunResult> {
        return this.runLifecycle.run(
            {
                sessionId: args.childSessionId,
                parentSessionId: args.parentSessionId,
                controller: args.abortController,
                signal: args.signal,
            },
            async (controller) => {
                const engine = this.engines[normalizeSubagentRuntime(args.runtime)];
                const tracksWork = !managedExternally && engine.capabilities.workLane;
                const handle = tracksWork
                    ? await this.reportResumeStart(args.childSessionId)
                    : undefined;
                const execute = async () => {
                    await engine.preflight(definition);
                    return engine.run({
                        ...args,
                        abortController: controller,
                        signal: controller.signal,
                    });
                };
                let result: SubagentRunResult;
                try {
                    result =
                        handle && this.workHooks?.run
                            ? await this.workHooks.run(handle.workId, args.childSessionId, execute)
                            : await execute();
                } catch (error) {
                    result = {
                        subSessionId: args.childSessionId,
                        resultText: error instanceof Error ? error.message : String(error),
                        isError: true,
                    };
                }
                if (tracksWork) await this.reportResumeSettle(args.childSessionId, result, handle);
                return result;
            },
        );
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
