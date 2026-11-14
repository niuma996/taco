import type { SessionId } from "@taco-ai/protocol";
import { agentToolPolicy, filterToolsForAgent } from "../../agents/filterTools.ts";
import type { AgentDefinition, SubagentProgressSink } from "../../agents/types.ts";
import type { SubagentBudgetState } from "../../tags/subagentBudget.ts";
import type { TacoTool } from "../../tools/index.ts";
import { readSessionFacts, type SessionFacts } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";
import type { SubagentSessionArgs } from "./subagentTypes.ts";

export interface ResumeSubagentArgs {
    parentSessionId: SessionId;
    parentToolCallId: string;
    subSessionId: SessionId;
    prompt: string;
    signal?: AbortSignal;
    onUpdate?: SubagentProgressSink;
    newTask?: boolean;
    managedExternally?: boolean;
    budget?: SubagentBudgetState;
    abortController?: AbortController;
    executionId?: string;
}

export interface SubagentResumeDeps {
    registry: SessionRegistry;
    findAgent(name: string): AgentDefinition | undefined;
    getTools(): TacoTool[];
    countAssistantTurns(id: SessionId): Promise<number>;
    execute(
        args: SubagentSessionArgs & { childSessionId: SessionId },
        managedExternally: boolean,
        definition: AgentDefinition,
    ): Promise<SubagentRunResult>;
}

/** An idle continuation rebuilds the original profile without changing session ownership. */
export async function runSubagentResume(
    args: ResumeSubagentArgs,
    deps: SubagentResumeDeps,
): Promise<SubagentRunResult> {
    // 1. Open the child session and read its facts. Verify it exists, is a
    //    subagent, and was spawned by the same parent that's now trying to
    //    resume. This is a trust boundary, so the checks below must run
    //    against persisted state, never a caller-supplied value.
    let md: SessionFacts;
    try {
        md = await deps.registry.withSession(args.subSessionId, (session) =>
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
    const def = agentType ? deps.findAgent(agentType) : undefined;
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
    if ((md.runtime ?? "standard") !== (def.runtime ?? "standard"))
        return {
            subSessionId: args.subSessionId,
            isError: true,
            resultText:
                "The agent definition changed runtime; the existing session cannot switch engines.",
        };
    const standard = md.runtime !== "claude-code" && md.runtime !== "codex";
    // Only the standard engine counts persisted assistant turns against its harness budget.
    let maxTurns = def.maxTurns;
    if (standard && !args.newTask && maxTurns !== undefined) {
        const used = await deps.countAssistantTurns(args.subSessionId);
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

    const childDepth = typeof md.depth === "number" ? md.depth : Number(md.depth ?? 0);
    return deps.execute(
        {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            childSessionId: args.subSessionId,
            agentType,
            prompt: args.prompt,
            runtime: md.runtime,
            resume: true,
            signal: args.signal,
            abortController: args.abortController,
            executionId: args.executionId,
            onUpdate: args.onUpdate,
            tools: standard ? filterToolsForAgent(deps.getTools(), def.tools, childDepth) : [],
            childDepth,
            toolPolicy: standard ? agentToolPolicy(def.tools, childDepth) : undefined,
            rolePrompt: def.systemPrompt,
            fewShots: def.fewShots,
            forkedContext: typeof md.forkedContext === "string" ? md.forkedContext : undefined,
            maxTurns,
            budget: args.budget ?? {
                turnsUsed: 0,
                startedAt: Date.now(),
                ...(maxTurns !== undefined ? { maxTurns } : {}),
            },
            resumability: "resumable",
            claudeCodeTools: def.tools,
            permissionMode: def.permissionMode,
            claudeCodeCwd: def.cwd,
            codexConfig: def.codex,
            codexTools: def.tools,
        },
        args.managedExternally === true,
        def,
    );
}
