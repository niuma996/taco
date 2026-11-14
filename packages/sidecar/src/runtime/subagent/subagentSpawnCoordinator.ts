import { asSessionId, type SessionId } from "@taco-ai/protocol";
import { agentToolPolicy, filterToolsForAgent } from "../../agents/filterTools.ts";
import { buildForkedContext, resolveContextMode } from "../../agents/forkedHistory.ts";
import type {
    AgentDefinition,
    SubagentContextMode,
    SubagentProgressSink,
    SubagentRuntime,
} from "../../agents/types.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { AgentMessage } from "../pi/types.ts";
import { uuidv7 } from "../pi/values.ts";
import { findBranchEntries, MAIN_BRANCH } from "../session/sessionBranch.ts";
import {
    readSessionFacts,
    resolveParentDepth,
    writeSessionFacts,
} from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { AgentConversationRuntime } from "./agentConversationRuntime.ts";
import type { AgentEngine, EngineRunRequest } from "./engines/types.ts";
import type { SubagentRunLifecycle } from "./subagentRunLifecycle.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";
import type { SubagentSessionArgs } from "./subagentTypes.ts";

export interface SubagentSpawnCoordinatorOptions {
    readonly sessionRegistry: SessionRegistry;
    readonly conversation: AgentConversationRuntime;
    readonly runLifecycle: SubagentRunLifecycle;
    readonly engines: Record<SubagentRuntime, AgentEngine>;
    readonly trackInFlight: <T>(
        parentSessionId: SessionId,
        parentToolCallId: string,
        run: () => Promise<T>,
    ) => Promise<T>;
    readonly emit: (event: string, payload: unknown) => void;
    readonly getTools: () => TacoTool[];
    readonly launchBackground: (
        args: SubagentSessionArgs,
        def: AgentDefinition,
        description?: string,
    ) => Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        background: true;
        resultPath: string;
    }>;
    readonly executeSubagentSession: (args: SubagentSessionArgs) => Promise<SubagentRunResult>;
}

function normalizedRuntime(runtime?: SubagentRuntime): SubagentRuntime {
    return runtime === "claude-code" || runtime === "codex" ? runtime : "standard";
}

export class SubagentSpawnCoordinator {
    private readonly sessionRegistry: SessionRegistry;
    private readonly conversation: AgentConversationRuntime;
    private readonly runLifecycle: SubagentRunLifecycle;
    private readonly engines: Record<SubagentRuntime, AgentEngine>;
    private readonly trackInFlight: SubagentSpawnCoordinatorOptions["trackInFlight"];
    private readonly getTools: SubagentSpawnCoordinatorOptions["getTools"];
    private readonly launchBackground: SubagentSpawnCoordinatorOptions["launchBackground"];
    private readonly executeSession: SubagentSpawnCoordinatorOptions["executeSubagentSession"];
    private readonly emitEvent: SubagentSpawnCoordinatorOptions["emit"];
    constructor(options: SubagentSpawnCoordinatorOptions) {
        this.sessionRegistry = options.sessionRegistry;
        this.conversation = options.conversation;
        this.runLifecycle = options.runLifecycle;
        this.engines = options.engines;
        this.trackInFlight = options.trackInFlight;
        this.executeSession = options.executeSubagentSession;
        this.getTools = options.getTools;
        this.launchBackground = options.launchBackground;
        this.emitEvent = options.emit;
    }
    private emit(event: string, payload: unknown): void {
        this.emitEvent(event, payload);
    }

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
                        return await this.runLifecycle.run(
                            {
                                sessionId: childSessionId,
                                parentSessionId: args.parentSessionId,
                                controller: args.abortController,
                                signal: args.signal,
                            },
                            (controller) =>
                                this.runSubagentSession({
                                    ...args,
                                    childSessionId,
                                    executionId: runId,
                                    abortController: controller,
                                    signal: controller.signal,
                                }),
                        );
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
    private async runSubagentSession(args: EngineRunRequest): Promise<SubagentRunResult> {
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

        return this.engines[normalizedRuntime(args.runtime)].run({
            ...args,
            childSessionId: asSessionId(childSessionId),
            abortController: args.abortController,
        });
    }

    async prepareAndRunSpawn(
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
        // Native engines own separate context stores; their adapters cannot import
        // a parent transcript. Correct a fork request to independent for them.
        const effectiveContextMode = this.engines[normalizedRuntime(def.runtime)].capabilities
            .forkContext
            ? contextMode
            : "independent";
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
            return this.executeSession({ ...sessionArgs, signal: args.signal });
        }
        return this.launchBackground(sessionArgs, def, args.description);
    }
    async appendChildMessages(childId: SessionId, messages: AgentMessage[]): Promise<void> {
        await this.sessionRegistry.withSession(childId, async (session) => {
            const branch =
                (await session.branch(MAIN_BRANCH, harnessContext)) ??
                (await session.createBranch(MAIN_BRANCH, null, harnessContext));
            for (const message of messages) {
                await branch.appendMessage(message, harnessContext);
                this.pushChildMessages(childId, message);
            }
        });
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
}
