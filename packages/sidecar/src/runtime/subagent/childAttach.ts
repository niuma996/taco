/**
 * Child-session attach assembly — builds the (tools, taskState, systemPrompt)
 * triple a subagent harness attaches with, including its permission boundary.
 *
 * Split out of `AgentSpawner` so the contributor order has exactly one
 * definition: a fresh spawn and a resume must produce the same prompt, and two
 * independent assemblies could drift and silently change what the child sees
 * mid-conversation.
 */

import type { CommandPermissionConfig, SessionId } from "@taco-ai/protocol";
import type { AgentFewShot } from "../../agents/types.ts";
import { PermissionBroker } from "../../permissions/permissionBroker.ts";
import {
    buildSystemPrompt,
    filterContributorsForTools,
    type SystemPromptContributor,
} from "../../prompts/buildSystemPrompt.ts";
import type { EnvironmentContext } from "../../prompts/index.ts";
import type { TacoTool } from "../../tools/index.ts";
import { createShellTool } from "../../tools/shellTool.ts";
import type { SessionTaskState } from "../session/sessionTaskState.ts";

/**
 * Agent types whose `shell` tool is swapped for a read-only-broker instance.
 *
 * Membership is a permission boundary, not a hint: these profiles tell the
 * model it must not mutate anything, and prose alone does not stop a shell
 * call. Any profile whose body claims read-only must be listed here, or the
 * child inherits the user's root-session allowlist and can write.
 */
export const READ_ONLY_SHELL_AGENT_TYPES: ReadonlySet<string> = new Set(["explorer", "reviewer"]);

export interface ChildAttachDeps {
    /**
     * Session-scoped tools plus the taskState they were built from. Both halves
     * must come from one call — pairing a taskState from one with tools built
     * elsewhere diverges the two TaskStore instances.
     */
    readonly toolsForChildSession: (
        sessionId: SessionId,
    ) => Promise<{ tools: TacoTool[]; taskState: SessionTaskState }>;
    /** Workspace-level contributors, filtered against the child's final toolset. */
    readonly systemPromptContributors: SystemPromptContributor[];
    /** Workspace-level `<project_context>` block; a rebuild never re-reads disk. */
    readonly projectContext: string;
    /** Parent's `<environment>` snapshot; without it a child in a workspace with no `.gitignore` would see no cwd/platform/shell at all. */
    readonly environmentContext?: EnvironmentContext;
    /** Parent's IM/channel flag — children inherit the path-semantics variant. */
    readonly hideWorkspacePath: boolean | undefined;
    /** Parent's rendered instruction blocks; a thunk so a settings.write reaches the child. */
    readonly getParentInstructionsBlock: () => string;
}

export interface ChildAttachArgs {
    sessionId: SessionId;
    agentType: string | undefined;
    childDepth: number;
    /** Already narrowed by the caller (whitelist + depth); this only intersects. */
    allowedTools: readonly TacoTool[];
    rolePrompt?: string;
    fewShots?: ReadonlyArray<AgentFewShot>;
    forkedContext?: string;
    modelIdentity: string | undefined;
}

/**
 * Assemble what a child harness attaches with.
 *
 * `allowedTools` is the already-narrowed toolset; this only intersects it with
 * the session-scoped rebuild, so no caller can widen a child's capabilities by
 * routing through here.
 */
export async function prepareChildAttach(
    deps: ChildAttachDeps,
    args: ChildAttachArgs,
): Promise<{ tools: TacoTool[]; taskState: SessionTaskState; systemPrompt: string }> {
    // Rebuild session-scoped tools so shell commands receive the child
    // session id and therefore use the same permission broker as main
    // sessions.
    const allowedNames = new Set(args.allowedTools.map((tool) => tool.name));
    const { tools: rawTools, taskState } = await deps.toolsForChildSession(args.sessionId);
    const tools = rawTools.filter((tool) => allowedNames.has(tool.name));

    // Read-only profiles get an isolated-broker shell so the user's
    // root-session allowlist cannot leak in. Membership in
    // READ_ONLY_SHELL_AGENT_TYPES is a permission boundary, not a hint.
    const shellIdx =
        args.agentType !== undefined && READ_ONLY_SHELL_AGENT_TYPES.has(args.agentType)
            ? tools.findIndex((t) => t.name === "shell")
            : -1;
    if (shellIdx !== -1) {
        const readonlyBroker = new PermissionBroker(
            () => ({ mode: "auto", allow: [], deny: [] }) satisfies CommandPermissionConfig,
            { readOnly: true },
        );
        // Replace in place so the toolset keeps its original ordering.
        tools[shellIdx] = createShellTool({
            permissionBroker: readonlyBroker,
            sessionId: args.sessionId,
        });
    }

    // Rebuild the system prompt from the child's actual toolset so read-only
    // agents (e.g. explorer) don't inherit shell instructions they cannot
    // act on. Contributors tagged with capability requirements (e.g.
    // `<available_skills>` requires the `skill` tool) are filtered against
    // that same toolset — otherwise the listing describes a tool the
    // subagent cannot call.
    const filteredContributors = filterContributorsForTools(
        deps.systemPromptContributors,
        new Set(tools.map((tool) => tool.name)),
    );
    const profileContributors: SystemPromptContributor[] = [];
    // Fork transcript first: it is background for the task, not the task.
    if (args.forkedContext) profileContributors.push({ append: args.forkedContext });
    // Few-shots before the role body so they establish the contract the
    // profile expects (citation shape, stop condition) before it takes over.
    const fewShotsBlock = formatFewShots(args.fewShots);
    if (fewShotsBlock) profileContributors.push({ append: fewShotsBlock });
    // Capability statement before the role body, so the profile's own prose
    // still wins on conflict — but the model knows what it can do before it
    // reads the role's instructions.
    const capabilitiesBlock = formatCapabilities(tools, args.agentType);
    if (capabilitiesBlock) profileContributors.push({ append: capabilitiesBlock });
    // Role body after the generic guidance so it wins on conflict — a
    // read-only explorer must not inherit the main agent's "act, then
    // verify" framing.
    const role = args.rolePrompt?.trim();
    if (role) profileContributors.push({ append: role });
    // Parent's resolved instruction blocks (CLAUDE.md / AGENTS.md /
    // DESIGN.md) last, so the agent's role body can override them. Read
    // through the thunk so a `settings.write` since the parent attached
    // reaches this child.
    const parentInstructions = deps.getParentInstructionsBlock();
    if (parentInstructions) profileContributors.push({ append: parentInstructions });

    const systemPrompt = buildSystemPrompt({
        tools,
        modelIdentity: args.modelIdentity,
        projectContext: deps.projectContext,
        environmentContext: deps.environmentContext,
        hideWorkspacePath: deps.hideWorkspacePath,
        contributors:
            profileContributors.length > 0
                ? [...filteredContributors, ...profileContributors]
                : filteredContributors,
        sessionKind: { role: "subagent", depth: args.childDepth },
    });

    return { tools, taskState, systemPrompt };
}

/**
 * Render a child agent's write capability into a prompt block.
 *
 * The general `<session_role>` guidance already says "if your task requires a
 * tool that is not available, explain it in your final response" — but it is
 * one line among many, and a task that names a concrete output path ("write
 * the report to X") reads as doable. A read-only reviewer asked to do exactly
 * that spends its whole budget preparing to write a file it has no tool to
 * write, and never delivers the report.
 *
 * So the statement is derived from the toolset the child actually got, not
 * from what its profile body claims.
 *
 * Two flavors, because "no `write` tool" and "cannot write a file" are not
 * the same claim. A profile whose shell is also read-only genuinely cannot
 * create a file by any route, so it gets the directive. A profile with a
 * working shell — `verification` runs builds and writes throwaway scripts —
 * only lacks the `write` / `edit` tools, and telling it it cannot write a
 * file would be false.
 *
 * Returns "" when the child can write — there is nothing to warn about.
 */
function formatCapabilities(tools: readonly TacoTool[], agentType: string | undefined): string {
    const names = new Set(tools.map((t) => t.name));
    if (names.has("write") || names.has("edit")) return "";
    const readOnlyShell = agentType !== undefined && READ_ONLY_SHELL_AGENT_TYPES.has(agentType);
    if (!readOnlyShell) {
        return [
            "<capabilities>",
            "You have no file-writing tools (`write` / `edit`).",
            "</capabilities>",
        ].join("\n");
    }
    return [
        "<capabilities>",
        "You have no file-writing tools, and your shell is read-only.",
        "If your task asks you to create or modify a file, you cannot do it. Do not retry, and do not",
        "look for another route to the same outcome — another tool, a shell pipeline, a redirect. Write",
        "the complete content in your final reply instead, and state plainly that no file was written.",
        "</capabilities>",
    ].join("\n");
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
