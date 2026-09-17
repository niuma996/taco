/**
 * AgentSpawner — subagent creation and execution: validates the agentType,
 * narrows the toolset, then drives the child to completion.
 *
 * The child's attach assembly lives in `./childAttach.ts`, its run loop in
 * `./subagentRunner.ts`, and the parent-depth read in `../session/sessionFacts.ts`.
 */

import { EventEmitter } from "node:events";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import { filterToolsForAgent } from "../../agents/filterTools.ts";
import { buildForkedContext, resolveContextMode } from "../../agents/forkedHistory.ts";
import type {
    AgentDefinition,
    AgentFewShot,
    SubagentContextMode,
    SubagentProgressSink,
} from "../../agents/types.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { SystemPromptContributor } from "../../prompts/buildSystemPrompt.ts";
import { interpolateArgs } from "../../skills/skillMessages.ts";
import type { SpawnSkillSubagentOptions } from "../../skills/skillTool.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { AttachedSession } from "../harness/attachedSession.ts";
import { findModelById } from "../models/modelRegistry.ts";
import type { NodeExecutionEnv } from "../pi/node.ts";
import type { Api, Model, MutableModels } from "../pi/types.ts";
import type { JsonlSessionRepo } from "../pi/values.ts";
import { uuidv7 } from "../pi/values.ts";
import { findBranchEntries } from "../session/sessionBranch.ts";
import {
    readSessionFacts,
    resolveParentDepth,
    type SessionFacts,
    writeSessionFacts,
} from "../session/sessionFacts.ts";
import type { AttachOptions, SessionRegistry } from "../session/sessionRegistry.ts";
import { type ChildAttachDeps, prepareChildAttach } from "./childAttach.ts";
import { runAttachedSubagent } from "./subagentRunner.ts";

export interface AgentSpawnerOptions {
    readonly cwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
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
    /** SessionRegistry reference — used to call attachChild / openSession / invalidateListCache. */
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
     * Profile body from the agent definition's markdown, appended to the
     * child's system prompt so the role, stop condition and reporting
     * contract actually reach the model. Skill subagents pass nothing —
     * their instructions are the prompt itself.
     */
    rolePrompt?: string;
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
     * Pre-rendered `<forked_context>` block, or undefined when this child runs
     * independent. Computed by `spawnSubagent` from the parent branch before
     * delegating; injected ahead of few-shots/role and persisted into the child
     * metadata so `agentContinue` resumes byte-identically.
     */
    forkedContext?: string;
    /** Calling tool's `onUpdate` sink — see subagentRunner for what it emits. */
    onUpdate?: SubagentProgressSink;
}

export class AgentSpawner extends EventEmitter {
    readonly sessionCwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
    readonly env: NodeExecutionEnv;
    readonly models: MutableModels;
    /** Public so tests can assert on the live parent toolset a spawn would see. */
    readonly getTools: () => TacoTool[];
    readonly agents: AgentDefinition[];
    private readonly sessionRegistry: SessionRegistry;
    private readonly systemPromptContributors: SystemPromptContributor[];

    constructor(options: AgentSpawnerOptions) {
        super();
        this.sessionCwd = options.cwd;
        this.repo = options.repo;
        this.env = options.env;
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
        this.hideWorkspacePath = options.hideWorkspacePath;
        this.getParentInstructionsBlock = options.getParentInstructionsBlock ?? (() => "");
        // In-flight resume promises keyed by subSessionId. Concurrent calls
        // share one promise instead of racing to re-attach the same session —
        // a second caller would otherwise see `attachChild` return the existing
        // AttachedSession, but each call would queue its own `prompt()` on it
        // and interleave user messages onto the same branch.
        this.resumeInFlight = new Map();
        this.inFlight = new Map();
    }

    /** Returns the parent default-model identity, used when `args.model` is omitted. */
    private readonly defaultModelIdentity: string | undefined;

    /** Workspace-level `<project_context>` block, passed through to rebuilt subagent prompts. */
    private readonly projectContext: string;
    /** Parent's IM/third-party channel flag, inherited by every rebuilt subagent prompt. */
    private readonly hideWorkspacePath: boolean | undefined;
    /**
     * Reads the parent instruction blocks (CLAUDE.md / AGENTS.md / DESIGN.md)
     * to inherit into subagent system prompts. Returns "" when nothing resolved
     * or inheritance is disabled via `InstructionsConfig.inheritToSubagents=false`.
     * Called per spawn/resume so a `settings.write` reaches the next child.
     */
    private readonly getParentInstructionsBlock: () => string;

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

    /** Looks up a subagent definition in the registry by `agentType`. */
    findAgent(type: string): AgentDefinition | undefined {
        return this.agents.find((a) => a.agentType === type);
    }

    /** parentToolCallIds with a live subagent under `parentSessionId`. */
    inFlightAgentToolCallIds(parentSessionId: SessionId): string[] {
        return [...(this.inFlight.get(parentSessionId) ?? [])];
    }

    /** Child-attach inputs this spawner owns — one definition so spawn and resume agree. */
    private get childAttachDeps(): ChildAttachDeps {
        return {
            toolsForChildSession: (sessionId) =>
                this.sessionRegistry.toolsForChildSession(sessionId),
            systemPromptContributors: this.systemPromptContributors,
            projectContext: this.projectContext,
            hideWorkspacePath: this.hideWorkspacePath,
            getParentInstructionsBlock: this.getParentInstructionsBlock,
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
     * Never throws — errors are wrapped in { isError: true }.
     */
    async executeSubagentSession(
        args: SubagentSessionArgs,
    ): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
        return this.trackInFlight(args.parentSessionId, args.parentToolCallId, () =>
            this.runSubagentSession(args),
        );
    }

    /** `executeSubagentSession` body, wrapped by it for in-flight tracking. */
    private async runSubagentSession(
        args: SubagentSessionArgs,
    ): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
        // Caller must supply `childDepth` — used by tool filtering to gate Skill/agent
        // recursion, and computing it here would require a second openSession() call.
        const childDepth =
            args.childDepth ??
            (() => {
                throw new Error("executeSubagentSession: childDepth must be provided by caller");
            })();

        // 1. Create child session. pi 0.85 fixed the metadata shape, so the
        //    sidecar's own attributes are written as session values straight
        //    after creation rather than passed to create().
        const childSessionId = uuidv7();
        const childSession = await this.repo.create(
            {
                id: childSessionId,
                cwd: this.sessionCwd,
                parentSessionId: args.parentSessionId,
            },
            harnessContext,
        );
        await writeSessionFacts(childSession, {
            kind: "subagent",
            agentType: args.agentType,
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            depth: childDepth,
            ...(args.forkedContext !== undefined ? { forkedContext: args.forkedContext } : {}),
        });
        // create() holds pi's open-session slot. attachChild() below opens the
        // same id again, which throws unless this handle is released first.
        await childSession.close(harnessContext);
        this.sessionRegistry.invalidateListCache();

        // 2. Emit spawned (same agentType as the persisted facts)
        this.emit("subagent.spawned", {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            subSessionId: childSessionId,
            agentType: args.agentType,
        });

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
                { thinkingLevel: "off", model: args.model } satisfies AttachOptions,
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

        return runAttachedSubagent({
            subSessionId: asSessionId(childSessionId),
            attached,
            prompt: args.prompt,
            agentType: args.agentType,
            maxTurns: args.maxTurns,
            signal: args.signal,
            onUpdate: args.onUpdate,
            readLastAssistantText: (id) => this.extractLastAssistantText(id),
        });
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
        context?: SubagentContextMode;
        signal?: AbortSignal;
        onUpdate?: SubagentProgressSink;
    }): Promise<{ subSessionId?: SessionId; resultText: string; isError: boolean }> {
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
        // Unlike childDepth there is a safe default, so an omitted value is not
        // a caller error — see resolveContextMode for the precedence rationale.
        const contextMode = resolveContextMode(args.context, def.context);
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
        if (contextMode === "fork") {
            forkedContext = await this.sessionRegistry.withSession(
                args.parentSessionId,
                async (parentSession) => buildForkedContext(await findBranchEntries(parentSession)),
            );
        }
        return this.executeSubagentSession({
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            agentType: def.agentType,
            prompt: args.prompt,
            tools: childTools,
            signal: args.signal,
            onUpdate: args.onUpdate,
            childDepth,
            rolePrompt: def.systemPrompt,
            fewShots: def.fewShots,
            maxTurns: def.maxTurns,
            forkedContext,
        });
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
    }): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
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
        const promise = this.trackInFlight(args.parentSessionId, args.parentToolCallId, () =>
            this.runResume(args).finally(() => {
                this.resumeInFlight.delete(args.subSessionId);
            }),
        );
        this.resumeInFlight.set(args.subSessionId, promise);
        return promise;
    }

    private async runResume(args: {
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        prompt: string;
        signal?: AbortSignal;
        onUpdate?: SubagentProgressSink;
    }): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
        // 1. Open the child session and read its facts. Verify it exists, is a
        //    subagent, and was spawned by the same parent that's now trying to
        //    resume. This is a trust boundary, so the checks below must run
        //    against persisted state, never a caller-supplied value.
        let md: SessionFacts;
        try {
            md = await this.sessionRegistry.withSession(args.subSessionId, (session) =>
                readSessionFacts(session),
            );
        } catch (e) {
            return {
                subSessionId: args.subSessionId,
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        }
        if (md?.kind !== "subagent") {
            return {
                subSessionId: args.subSessionId,
                resultText: `cannot continue: session ${args.subSessionId} is not a subagent`,
                isError: true,
            };
        }
        if (md?.parentSessionId !== args.parentSessionId) {
            // A different parent (or a stale tool_call_id) trying to reach
            // into someone else's subagent would cross security boundaries
            // and break the implicit "same parent, same conversation" contract.
            return {
                subSessionId: args.subSessionId,
                resultText: "cannot continue: subagent belongs to a different parent session",
                isError: true,
            };
        }

        const agentType = typeof md.agentType === "string" ? md.agentType : undefined;
        const def = agentType ? this.findAgent(agentType) : undefined;
        if (agentType === undefined || !def) {
            // The original profile (agentType) is gone — either the file was
            // deleted, or the agentType string was renamed. Falling back to
            // the parent's full toolset here would grant the resumed subagent
            // more capabilities than it had at spawn time (e.g. a read-only
            // explorer gaining shell / write). Fail closed instead: the user
            // must spawn a fresh subagent under a valid profile. Conversation
            // history is preserved on disk but no longer reachable from here.
            return {
                subSessionId: args.subSessionId,
                resultText: `cannot continue: agent definition for "${agentType ?? "unknown"}" is no longer available. Re-spawn the subagent to continue.`,
                isError: true,
            };
        }
        // 2. Compute remaining turn budget. We don't have a turn_end counter
        //    on disk — assistant messages count one-per-turn and survive across
        //    resumes. Subtract from `def.maxTurns`; fail fast when depleted
        //    rather than burn one more LLM round to discover the cap.
        let maxTurns = def.maxTurns;
        if (maxTurns !== undefined) {
            const used = await this.countAssistantTurns(args.subSessionId);
            const remaining = maxTurns - used;
            if (remaining <= 0) {
                return {
                    subSessionId: args.subSessionId,
                    resultText: `cannot continue: subagent exhausted its ${maxTurns}-turn budget (used ${used})`,
                    isError: true,
                };
            }
            maxTurns = remaining;
        }

        // 3. Rebuild the system prompt from the original agentType's profile
        //    + few-shots, filtered through the same toolset the spawn used.
        //    def is guaranteed non-undefined by the early return above.
        const childDepth = typeof md.depth === "number" ? md.depth : Number(md.depth ?? 0);
        const {
            tools: attachedChildTools,
            taskState: childTaskState,
            systemPrompt: childSystemPrompt,
        } = await prepareChildAttach(this.childAttachDeps, {
            sessionId: args.subSessionId,
            agentType,
            childDepth,
            allowedTools: filterToolsForAgent(this.getTools(), def.tools, childDepth),
            rolePrompt: def.systemPrompt,
            fewShots: def.fewShots,
            // Re-inject the fork transcript from the spawn-time snapshot so a
            // resume sees the same context the child started with, even if the
            // parent has since compacted or continued.
            forkedContext: typeof md.forkedContext === "string" ? md.forkedContext : undefined,
            modelIdentity: this.defaultModelIdentity,
        });

        // 4. Attach (returns the existing AttachedSession if still attached).
        let attached: AttachedSession;
        try {
            attached = await this.sessionRegistry.attachChild(
                args.subSessionId,
                { thinkingLevel: "off" },
                attachedChildTools,
                childTaskState,
                childSystemPrompt,
            );
        } catch (e) {
            return {
                subSessionId: args.subSessionId,
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        }

        return runAttachedSubagent({
            subSessionId: args.subSessionId,
            attached,
            prompt: args.prompt,
            agentType,
            maxTurns,
            signal: args.signal,
            onUpdate: args.onUpdate,
            readLastAssistantText: (id) => this.extractLastAssistantText(id),
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
            childDepth,
        });
    }
}
