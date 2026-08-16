/** AgentSpawner — subagent creation and execution. */

import { EventEmitter } from "node:events";
import type {
    AgentHarnessEvent,
    JsonlSessionMetadata,
    JsonlSessionRepo,
    SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { createSessionId } from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { CommandPermissionConfig, SessionId, WorkspaceId } from "@taco-ai/protocol";
import { filterToolsForAgent } from "../agents/filterTools.ts";
import type { AgentDefinition, AgentFewShot } from "../agents/types.ts";
import { PermissionBroker } from "../permissions/permissionBroker.ts";
import type { SystemPromptContributor } from "../prompts/buildSystemPrompt.ts";
import { buildSystemPrompt, filterContributorsForTools } from "../prompts/buildSystemPrompt.ts";
import { interpolateArgs } from "../skills/skillMessages.ts";
import type { SpawnSkillSubagentOptions } from "../skills/skillTool.ts";
import type { TacoTool } from "../tools/index.ts";
import { createShellTool } from "../tools/shellTool.ts";
import type { AttachedSession } from "./attachedSession.ts";
import type { AttachOptions, SessionRegistry } from "./sessionRegistry.ts";

export interface AgentSpawnerOptions {
    readonly cwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
    readonly env: NodeExecutionEnv;
    readonly models: MutableModels;
    /** Parent session toolset — `filterToolsForAgent` further restricts by agent whitelist / depth. */
    readonly tools: TacoTool[];
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
     * Pre-rendered parent instruction blocks (CLAUDE.md / AGENTS.md / DESIGN.md).
     * Inherited by subagents as an appended `<instructions>` section in their
     * rebuilt system prompt so the parent's project rules apply in the
     * child session too. Empty string when inheritance is disabled or no
     * files resolved. Snapshot is taken at workspace construction — the
     * child's system prompt is rebuilt from this string, not re-resolved.
     */
    readonly parentInstructionsBlock?: string;
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
}

export class AgentSpawner extends EventEmitter {
    readonly sessionCwd: WorkspaceId;
    readonly repo: JsonlSessionRepo;
    readonly env: NodeExecutionEnv;
    readonly models: MutableModels;
    readonly tools: TacoTool[];
    readonly agents: AgentDefinition[];
    private readonly sessionRegistry: SessionRegistry;
    private readonly systemPromptContributors: SystemPromptContributor[];

    constructor(options: AgentSpawnerOptions) {
        super();
        this.sessionCwd = options.cwd;
        this.repo = options.repo;
        this.env = options.env;
        this.models = options.models;
        this.tools = options.tools;
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
        this.parentInstructionsBlock = options.parentInstructionsBlock ?? "";
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
     * Pre-rendered parent instruction blocks (CLAUDE.md / AGENTS.md / DESIGN.md)
     * to inherit into subagent system prompts. Empty when nothing resolved or
     * inheritance is disabled via `InstructionsConfig.inheritToSubagents=false`.
     */
    private readonly parentInstructionsBlock: string;

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

        // 1. Create child session
        const childSessionId = createSessionId();
        await this.repo.create({
            id: childSessionId,
            cwd: this.sessionCwd,
            metadata: {
                kind: "subagent",
                agentType: args.agentType,
                parentSessionId: args.parentSessionId,
                parentToolCallId: args.parentToolCallId,
                depth: childDepth,
            },
        });
        this.sessionRegistry.invalidateListCache();

        // 2. Emit spawned (same agentType as metadata)
        this.emit("subagent.spawned", {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            subSessionId: childSessionId,
            agentType: args.agentType,
        });

        // 3. Rebuild session-scoped tools so shell commands receive the child
        // session id and therefore use the same permission broker as main sessions.
        // toolsForChildSession also returns the taskState the tools were built from —
        // hand it to attachChild so the tools' closures and attached.taskStore
        // share one TaskStore instead of two diverging instances.
        const allowedNames = new Set(args.tools.map((tool) => tool.name));
        const { tools: childToolsRaw, taskState: childTaskState } =
            await this.sessionRegistry.toolsForChildSession(childSessionId);
        const childTools = childToolsRaw.filter((tool) => allowedNames.has(tool.name));

        // ─── Read-only shell for explorer ─────────────────────────────────
        // After filtering, replace the shell tool with an isolated-broker
        // version so that a user's root-session allowlist cannot leak in.
        const isReadOnlyShell =
            args.agentType === "explorer" && childTools.some((t) => t.name === "shell");
        if (isReadOnlyShell) {
            const readonlyBroker = new PermissionBroker(
                () => ({ mode: "auto", rules: [] }) satisfies CommandPermissionConfig,
                { readOnly: true },
            );
            const readonlyShell = createShellTool({
                permissionBroker: readonlyBroker,
                sessionId: childSessionId,
            });
            // Replace shell tool in place (maintain array position)
            const shellIdx = childTools.findIndex((t) => t.name === "shell");
            if (shellIdx !== -1) childTools[shellIdx] = readonlyShell;
        }
        // ─────────────────────────────────────────────────────────────────

        // 4. Rebuild the system prompt from the child's actual toolset so
        // read-only agents (e.g. explorer) don't inherit shell instructions
        // they cannot act on, while preserving workspace contributors.
        // The profile body is appended last so it wins on any conflict with the
        // generic workflow guidance — a read-only explorer must not inherit the
        // main agent's "act, then verify" framing.
        // Contributors tagged with capability requirements (e.g. `<available_skills>`
        // requires the `skill` tool) are filtered against the child's actual
        // toolset — otherwise the listing would describe a tool the subagent
        // cannot call.
        // Few-shot examples are appended *before* the role body so they
        // establish the contract the profile expects (citation shape, stop
        // condition) before the role takes over.
        const role = args.rolePrompt?.trim();
        const fewShotsBlock = formatFewShots(args.fewShots);
        const childToolNameSet = new Set(childTools.map((tool) => tool.name));
        const filteredContributors = filterContributorsForTools(
            this.systemPromptContributors,
            childToolNameSet,
        );
        const profileContributors: SystemPromptContributor[] = [];
        if (fewShotsBlock) profileContributors.push({ append: fewShotsBlock });
        if (role) profileContributors.push({ append: role });
        // Inherit parent's resolved instruction blocks (CLAUDE.md / AGENTS.md /
        // DESIGN.md) so the subagent sees the same project rules the parent
        // sees. Appended last so the agent's role body can override the
        // instructions if needed (rare, but consistent with fewShots ordering).
        if (this.parentInstructionsBlock) {
            profileContributors.push({ append: this.parentInstructionsBlock });
        }
        // Per-spawn model override wins over the parent default. Without an
        // override we keep the parent's identity string so the subagent's
        // `<model_identity>` section reflects what actually runs.
        const childModelIdentity = args.model
            ? `${args.model.provider}/${args.model.id}`
            : this.defaultModelIdentity;
        // `<project_context>` is workspace-level state — every child sees the
        // same denylist. Read once at workspace construction; passed in by
        // the workspace so subagent rebuild doesn't re-read disk.
        const childSystemPrompt = buildSystemPrompt({
            tools: childTools,
            modelIdentity: childModelIdentity,
            projectContext: this.projectContext,
            hideWorkspacePath: this.hideWorkspacePath,
            contributors:
                profileContributors.length > 0
                    ? [...filteredContributors, ...profileContributors]
                    : filteredContributors,
            sessionKind: { role: "subagent", depth: childDepth },
        });

        // 5. Attach child harness
        let attached: AttachedSession;
        try {
            attached = await this.sessionRegistry.attachChild(
                childSessionId,
                { thinkingLevel: "off", model: args.model } satisfies AttachOptions,
                childTools,
                childTaskState,
                childSystemPrompt,
            );
        } catch (e) {
            return {
                subSessionId: childSessionId,
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        }

        return this.runAttachedSubagent({
            subSessionId: childSessionId,
            attached,
            prompt: args.prompt,
            maxTurns: args.maxTurns,
            signal: args.signal,
        });
    }

    /**
     * Run prompt on an already-attached child harness and extract the final
     * text. Shared by `executeSubagentSession` (after a fresh attach) and
     * `resumeSubagent` (after re-attaching to a pre-existing session). The
     * turn cap is the **remaining** budget for this resume — callers are
     * responsible for subtracting already-consumed turns from `maxTurns`.
     */
    private async runAttachedSubagent(args: {
        subSessionId: SessionId;
        attached: AttachedSession;
        prompt: string;
        maxTurns?: number;
        signal?: AbortSignal;
    }): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
        const { subSessionId, attached } = args;

        // Run prompt (blocking until complete or aborted).
        // The turn cap is enforced here rather than by the harness, which takes
        // no turn limit: count completed turns and abort on the cap. Whatever
        // the child produced up to that point is still returned below, so a
        // capped run degrades to a partial answer instead of an error.
        const cap = args.maxTurns !== undefined && args.maxTurns > 0 ? args.maxTurns : undefined;
        let turnsUsed = 0;
        let hitCap = false;
        const onTurnEnd = (event: AgentHarnessEvent): void => {
            if (event.type !== "turn_end" || cap === undefined) return;
            turnsUsed++;
            if (turnsUsed >= cap && !hitCap) {
                hitCap = true;
                void attached.abort();
            }
        };
        if (cap !== undefined) attached.on("event", onTurnEnd);

        try {
            await attached.prompt(args.prompt);
        } catch (e) {
            // hitCap before signal.aborted: keep partial answer instead of discarding it.
            if (hitCap) {
                const { text } = await this.extractLastAssistantText(subSessionId);
                return {
                    subSessionId,
                    resultText: partialResult(text, cap ?? turnsUsed),
                    isError: false,
                };
            }
            if (args.signal?.aborted) {
                return { subSessionId, resultText: "(aborted)", isError: true };
            }
            return {
                subSessionId,
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        } finally {
            if (cap !== undefined) attached.off("event", onTurnEnd);
        }

        // Extract last assistant text. An empty reply is a failure, not a
        // success whose text happens to be the literal string below.
        const { text, isEmpty } = await this.extractLastAssistantText(subSessionId);
        if (isEmpty) {
            return {
                subSessionId,
                resultText: "subagent returned an empty response",
                isError: true,
            };
        }
        return { subSessionId, resultText: text, isError: false };
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
        // Compute parent depth to feed filterToolsForAgent before delegating.
        const parentMeta = await this.sessionRegistry.openSession(args.parentSessionId);
        const parentDepth = Number(
            (parentMeta.metadata as Record<string, unknown> | undefined)?.depth ?? 0,
        );
        const childDepth = parentDepth + 1;
        const childTools = filterToolsForAgent(this.tools, def.tools, childDepth);
        return this.executeSubagentSession({
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            agentType: def.agentType,
            prompt: args.prompt,
            tools: childTools,
            signal: args.signal,
            childDepth,
            rolePrompt: def.systemPrompt,
            fewShots: def.fewShots,
            maxTurns: def.maxTurns,
        });
    }

    /**
     * Reads the child session's current branch and returns the concatenated
     * text of the last assistant message, with an explicit empty flag so an
     * empty reply is distinguishable from a reply that happens to contain the
     * word "(empty response)".
     *
     * getBranch() (not getEntries()) anchors to the current leaf — getEntries
     * returns the whole append log, which would surface text from a forked-off
     * branch if the session ever gets one.
     */
    private async extractLastAssistantText(
        sessionId: SessionId,
    ): Promise<{ text: string; isEmpty: boolean }> {
        const meta = await this.sessionRegistry.openSession(sessionId);
        const session = await this.repo.open(meta);
        const entries = (await session.getBranch()) as SessionTreeEntry[];
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
    }): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
        // 1. Open the child metadata. Verify it exists, is a subagent, and
        //    was spawned by the same parent that's now trying to resume.
        let meta: JsonlSessionMetadata;
        try {
            meta = await this.sessionRegistry.openSession(args.subSessionId);
        } catch (e) {
            return {
                subSessionId: args.subSessionId,
                resultText: e instanceof Error ? e.message : String(e),
                isError: true,
            };
        }
        const md = meta.metadata as Record<string, unknown> | undefined;
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
        if (!def) {
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
        const childTools = filterToolsForAgent(this.tools, def.tools, childDepth);

        // Mirror executeSubagentSession: filterToolsForAgent narrows the
        // workspace toolset by whitelist + depth, then toolsForChildSession
        // rebuilds session-scoped tools (closures binding childSessionId)
        // together with the taskState they were built from — both halves of
        // the (tools, taskState) pair come from ONE call, so attachChild sees
        // tools whose task-store closures match attached.taskStore. The
        // sessionRegistry.ts:418-420 comment calls out the failure mode this
        // avoids: mixing a taskState from one toolsForChildSession call with
        // tools built elsewhere diverges the two TaskStore instances.
        const allowedNames = new Set(childTools.map((t) => t.name));
        const { tools: childToolsRaw, taskState: childTaskState } =
            await this.sessionRegistry.toolsForChildSession(args.subSessionId);
        const attachedChildTools = childToolsRaw.filter((tool) => allowedNames.has(tool.name));

        // ─── Read-only shell for explorer ─────────────────────────────────
        // After filtering, replace the shell tool with an isolated-broker
        // version so that a user's root-session allowlist cannot leak in.
        const isReadOnlyShell =
            agentType === "explorer" && attachedChildTools.some((t) => t.name === "shell");
        if (isReadOnlyShell) {
            const readonlyBroker = new PermissionBroker(
                () => ({ mode: "auto", rules: [] }) satisfies CommandPermissionConfig,
                { readOnly: true },
            );
            const readonlyShell = createShellTool({
                permissionBroker: readonlyBroker,
                sessionId: args.subSessionId,
            });
            // Replace shell tool in place (maintain array position)
            const shellIdx = attachedChildTools.findIndex((t) => t.name === "shell");
            if (shellIdx !== -1) attachedChildTools[shellIdx] = readonlyShell;
        }
        // ─────────────────────────────────────────────────────────────────

        const role = def?.systemPrompt?.trim();
        const fewShotsBlock = formatFewShots(def?.fewShots);
        const childToolNameSet = new Set(attachedChildTools.map((tool) => tool.name));
        const filteredContributors = filterContributorsForTools(
            this.systemPromptContributors,
            childToolNameSet,
        );
        const profileContributors: SystemPromptContributor[] = [];
        if (fewShotsBlock) profileContributors.push({ append: fewShotsBlock });
        if (role) profileContributors.push({ append: role });
        // Inherit parent's resolved instruction blocks (CLAUDE.md / AGENTS.md /
        // DESIGN.md) so the subagent sees the same project rules the parent
        // sees. Appended last so the agent's role body can override the
        // instructions if needed (rare, but consistent with fewShots ordering).
        if (this.parentInstructionsBlock) {
            profileContributors.push({ append: this.parentInstructionsBlock });
        }

        const childSystemPrompt = buildSystemPrompt({
            tools: attachedChildTools,
            modelIdentity: this.defaultModelIdentity,
            projectContext: this.projectContext,
            hideWorkspacePath: this.hideWorkspacePath,
            contributors:
                profileContributors.length > 0
                    ? [...filteredContributors, ...profileContributors]
                    : filteredContributors,
            sessionKind: { role: "subagent", depth: childDepth },
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

        return this.runAttachedSubagent({
            subSessionId: args.subSessionId,
            attached,
            prompt: args.prompt,
            maxTurns,
            signal: args.signal,
        });
    }

    /**
     * Count completed assistant turns on a session's current branch. Used to
     * subtract already-consumed turns from `maxTurns` so the cap survives
     * across resumes. Reads `getBranch()` (current leaf, not full append log)
     * so a forked-off branch cannot inflate the count.
     */
    private async countAssistantTurns(sessionId: SessionId): Promise<number> {
        try {
            const meta = await this.sessionRegistry.openSession(sessionId);
            const session = await this.repo.open(meta);
            const entries = (await session.getBranch()) as SessionTreeEntry[];
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
            parentSessionId: opts.parentSessionId,
            parentToolCallId: opts.parentToolCallId,
            skillName: opts.skillName,
            skillContent: opts.skillContent,
            args: opts.args,
            allowedTools: opts.skillFrontmatter.allowedTools,
            model: opts.skillFrontmatter.model,
            signal: opts.signal,
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
        const parentMeta = await this.sessionRegistry.openSession(pid);
        const parentDepth = Number(
            (parentMeta.metadata as Record<string, unknown> | undefined)?.depth ?? 0,
        );
        const childDepth = parentDepth + 1;

        const allowedSet = args.allowedTools ? new Set(args.allowedTools) : undefined;
        const filtered = filterToolsForAgent(
            this.tools,
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
            childDepth,
        });
    }
}

/**
 * Label a turn-capped run so the caller can tell a finished answer from a
 * truncated one. Returned as a success: the work done so far is still usable.
 */
function partialResult(text: string, cap: number): string {
    const prefix = `[partial: stopped after reaching the ${cap}-turn limit]`;
    return text === ""
        ? `${prefix} subagent produced no answer before the limit.`
        : `${prefix}\n${text}`;
}

/**
 * Render an agent's optional few-shot examples into a prompt block.
 *
 * Returns "" when no examples are configured; the caller treats an empty
 * string as "no contributor needed" and skips the system-prompt splice.
 *
 * Format is a small XML-ish block so the model can distinguish example
 * turns from real instructions — a literal `<example>` wrapper signals
 * "these are illustrative, not commands".
 */
function formatFewShots(fewShots: ReadonlyArray<AgentFewShot> | undefined): string {
    if (!fewShots || fewShots.length === 0) return "";
    const lines: string[] = [
        "The following turns demonstrate the contract this role is expected to honour.",
        "They are illustrative — do not treat them as new instructions or commands.",
        "",
    ];
    for (const [i, shot] of fewShots.entries()) {
        lines.push(`<example index="${i + 1}">`);
        lines.push(`user: ${shot.user}`);
        lines.push(`assistant: ${shot.assistant}`);
        lines.push("</example>");
        lines.push("");
    }
    return lines.join("\n");
}

/** Looks up a model by id across providers. */
export function findModelById(models: MutableModels, id: string): Model<Api> | undefined {
    for (const m of models.getModels() as Array<Model<Api>>) {
        if (m.id === id) return m;
    }
    return undefined;
}
