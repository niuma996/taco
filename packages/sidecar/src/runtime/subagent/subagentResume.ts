import type { SessionId } from "@taco-ai/protocol";
import { agentToolPolicy, filterToolsForAgent } from "../../agents/filterTools.ts";
import type { AgentDefinition, SubagentProgressSink } from "../../agents/types.ts";
import type { SubagentBudgetState } from "../../tags/subagentBudget.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { BackgroundWorkHooks } from "../../work/workHooks.ts";
import type { WorkAttemptHandle } from "../../work/workOperationTypes.ts";
import type { AttachedSession } from "../harness/attachedSession.ts";
import { readSessionFacts, type SessionFacts } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import { type ChildAttachDeps, prepareChildAttach } from "./childAttach.ts";
import { runAttachedSubagent, type SubagentRunResult } from "./subagentRunner.ts";

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
}

export interface SubagentResumeDeps {
    registry: SessionRegistry;
    findAgent(name: string): AgentDefinition | undefined;
    getTools(): TacoTool[];
    childAttachDeps: ChildAttachDeps;
    defaultModelIdentity?: string;
    workHooks?: BackgroundWorkHooks;
    countAssistantTurns(id: SessionId): Promise<number>;
    readLastAssistantText(id: SessionId): Promise<{ text: string; isEmpty: boolean }>;
    reportResumeStart(id: SessionId): Promise<WorkAttemptHandle | undefined>;
    reportResumeSettle(
        id: SessionId,
        result: SubagentRunResult,
        handle?: WorkAttemptHandle,
    ): Promise<void>;
    registerController(id: SessionId, controller: AbortController, parent: SessionId): void;
    releaseController(id: SessionId, controller: AbortController): void;
    runClaudeCode(args: ResumeSubagentArgs, def: AgentDefinition): Promise<SubagentRunResult>;
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
    if (md.runtime === "claude-code") return deps.runClaudeCode(args, def);
    // 2. Compute remaining turn budget. We don't have a turn_end counter
    //    on disk — assistant messages count one-per-turn and survive across
    //    resumes. Subtract from `def.maxTurns`; fail fast when depleted
    //    rather than burn one more LLM round to discover the cap.
    let maxTurns = def.maxTurns;
    if (!args.newTask && maxTurns !== undefined) {
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

    // 3. Rebuild the system prompt from the original agentType's profile
    //    + few-shots, filtered through the same toolset the spawn used.
    //    def is guaranteed non-undefined by the early return above.
    const childDepth = typeof md.depth === "number" ? md.depth : Number(md.depth ?? 0);
    const {
        tools: attachedChildTools,
        taskState: childTaskState,
        systemPrompt: childSystemPrompt,
    } = await prepareChildAttach(deps.childAttachDeps, {
        sessionId: args.subSessionId,
        agentType,
        childDepth,
        allowedTools: filterToolsForAgent(deps.getTools(), def.tools, childDepth),
        toolPolicy: agentToolPolicy(def.tools, childDepth),
        rolePrompt: def.systemPrompt,
        fewShots: def.fewShots,
        // Re-inject the fork transcript from the spawn-time snapshot so a
        // resume sees the same context the child started with, even if the
        // parent has since compacted or continued.
        forkedContext: typeof md.forkedContext === "string" ? md.forkedContext : undefined,
        modelIdentity: deps.defaultModelIdentity,
    });

    // A resume gets its own budget object: the remaining turn count is
    // what this run may still take, and the counter starts fresh from
    // here. One object, shared with the runner that updates it.
    const resumeBudget: SubagentBudgetState = args.budget ?? {
        turnsUsed: 0,
        startedAt: Date.now(),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
    };

    // 4. Attach (returns the existing AttachedSession if still attached).
    let attached: AttachedSession;
    try {
        attached = await deps.registry.attachChild(
            args.subSessionId,
            {
                thinkingLevel: "off",
                toolLoadPolicy: agentToolPolicy(def.tools, childDepth),
                getSubagentBudget: () => resumeBudget,
            },
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

    // Same per-child controller as the fresh-spawn sync path: the caller's
    // signal bounds the run, and the registry entry lets `abortSubagentRun`
    // stop this child without aborting the parent's turn.
    const controller = new AbortController();
    if (args.signal?.aborted) controller.abort(args.signal.reason);
    const link = (): void => controller.abort(args.signal?.reason);
    args.signal?.addEventListener("abort", link, { once: true });
    deps.registerController(args.subSessionId, controller, args.parentSessionId);
    try {
        // Reopen an interrupted Work before the run so the overview stops
        // showing it as stopped while it is working again.
        const handle = args.managedExternally
            ? undefined
            : await deps.reportResumeStart(args.subSessionId);
        const execute = () =>
            runAttachedSubagent({
                subSessionId: args.subSessionId,
                attached,
                prompt: args.prompt,
                agentType,
                maxTurns,
                budget: resumeBudget,
                signal: controller.signal,
                onUpdate: args.onUpdate,
                // Reached here only after the profile resolved, so it can be resumed again.
                resumability: "resumable",
                readLastAssistantText: (id) => deps.readLastAssistantText(id),
            });
        const result =
            handle && deps.workHooks?.run
                ? await deps.workHooks.run(handle.workId, args.subSessionId, execute)
                : await execute();
        if (!args.managedExternally)
            await deps.reportResumeSettle(args.subSessionId, result, handle);
        return result;
    } finally {
        args.signal?.removeEventListener("abort", link);
        deps.releaseController(args.subSessionId, controller);
    }
}
