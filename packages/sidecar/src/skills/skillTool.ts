/**
 * SkillTool — lets the LLM invoke a named skill by injecting its body into context.
 * Input: { skill: string (name), args?: string }
 *
 *  - inline skills: enqueue a `<skill_body:NAME>` message for the reinjector
 *    hook. Body is NOT in the tool result (avoids cache-key bloat and
 *    double-delivery with the pending queue).
 *  - subagent skills: calls spawnSkillSubagent to run in a sandboxed session.
 */

import type { AgentTool, AgentToolResult, Skill } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";

import { readSkillFrontmatter, type SkillFrontmatter } from "./skillFrontmatter.ts";
import { createSkillBodyMessage } from "./skillMessages.ts";
import type { SkillReinjectorHandle } from "./skillReinjector.ts";

export interface SkillToolDetails {
    skillName: string;
    found: boolean;
    runAs?: "inline" | "subagent";
}

export interface SkillSubagentResult {
    /** Absent when the spawn failed before a child session existed. */
    subSessionId?: string;
    resultText: string;
    isError: boolean;
}

export interface SpawnSkillSubagentOptions {
    /** Parent session id — required so the subagent session has correct metadata + depth chain. */
    parentSessionId: string;
    parentToolCallId: string;
    /** Skill name — used for subagent metadata (agentType, parentSessionId linking) and log messages. */
    skillName: string;
    /** Full skill payload — content + frontmatter. Spawner picks runAs / allowedTools / model from `frontmatter`. */
    skillContent: string;
    skillFrontmatter: SkillFrontmatter;
    args: string;
    signal?: AbortSignal;
}

const skillSchema = Type.Object({
    skill: Type.String({ description: "The name of the skill to invoke." }),
    args: Type.Optional(
        Type.String({ description: "Arguments to pass to the skill ($ARGUMENTS or appended)." }),
    ),
});
type SkillToolInput = Static<typeof skillSchema>;

/**
 * Factory: builds the Skill tool with access to the skill list.
 * getSkills is a thunk, not a snapshot array — SessionRegistry mutates its
 * backing skill list on hot reload (see updateSkills), and re-reading on
 * every execute() is what makes an already-built tool object see the
 * post-reload list without the workspace rebuilding the tool itself.
 * spawnSkillSubagent is optional — if absent, subagent mode returns a clear error.
 * parentSessionId is captured in the closure so subagent mode can set correct metadata.
 * getReinjector is a thunk that returns the per-session reinjector handle (set after
 * AttachedSession.create() wires the harness hooks).
 */
export function createSkillTool(
    getSkills: () => readonly Skill[],
    options: {
        parentSessionId: string;
        getReinjector: () => SkillReinjectorHandle | undefined;
        spawnSkillSubagent?: (opts: SpawnSkillSubagentOptions) => Promise<SkillSubagentResult>;
        /**
         * Appended to the tool description — where a new SKILL.md should go and
         * which frontmatter keys taco reads. Falsy (including "") is treated as
         * "omit": callers that don't have a workspace-resolved guidance string
         * (e.g. ad-hoc test construction) get the base description unchanged.
         */
        skillAuthoringGuidance?: string;
    },
): AgentTool<typeof skillSchema> {
    const { parentSessionId, getReinjector, spawnSkillSubagent, skillAuthoringGuidance } = options;
    const baseDescription =
        "Invoke a skill — a specialized playbook or workflow loaded from the skill library. " +
        "Use this when the task matches a skill's description. " +
        "The skill body is injected into context after this call completes.";
    return {
        name: "skill",
        label: "skill",
        description: skillAuthoringGuidance
            ? `${baseDescription}\n\n${skillAuthoringGuidance}`
            : baseDescription,
        parameters: skillSchema,

        async execute(
            toolCallId: string,
            params: SkillToolInput,
            signal?: AbortSignal,
        ): Promise<AgentToolResult<SkillToolDetails>> {
            const skills = getSkills();
            const skill = skills.find((s) => s.name === params.skill);
            if (!skill) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Skill "${params.skill}" not found. Available skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
                        },
                    ],
                    details: { skillName: params.skill, found: false },
                };
            }

            const skillFrontmatter = readSkillFrontmatter(skill.filePath);
            const runAs = skillFrontmatter.runAs ?? "inline";

            // inlineOnly: a skill that only makes sense in the calling session.
            // The fan-out skill is the canonical example — it teaches the model
            // to dispatch `agent` calls, which a subagent cannot route back to
            // the parent. Reject subagent-mode invocation up front so the model
            // sees a clear error in the tool result and can correct the call,
            // rather than silently running the wrong shape.
            if (runAs === "subagent" && skillFrontmatter.inlineOnly === true) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Skill "${skill.name}" is inline-only and cannot run as a subagent. Invoke it from the main session via the inline path instead.`,
                        },
                    ],
                    details: { skillName: skill.name, found: true, runAs: "subagent" },
                };
            }

            if (runAs === "subagent") {
                if (!spawnSkillSubagent) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Skill "${skill.name}" requires subagent mode, which is not available in this context.`,
                            },
                        ],
                        details: { skillName: skill.name, found: true, runAs: "subagent" },
                    };
                }

                const result = await spawnSkillSubagent({
                    parentSessionId,
                    parentToolCallId: toolCallId,
                    skillName: skill.name,
                    skillContent: skill.content,
                    skillFrontmatter,
                    args: params.args ?? "",
                    signal,
                });

                const text = result.isError
                    ? `skill subagent error: ${result.resultText}`
                    : result.resultText;

                return {
                    content: [{ type: "text", text }],
                    details: { skillName: skill.name, found: true, runAs: "subagent" },
                };
            }

            // Inline path — push to per-session reinjector.
            const reinjector = getReinjector();
            if (reinjector) {
                reinjector.markInvoked(skill.name);
                const msg = createSkillBodyMessage(skill, params.args ?? "");
                reinjector.enqueueInlineInjection(msg);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: reinjector
                            ? `Skill "${skill.name}" activated. The skill body is now available in context.`
                            : `Skill "${skill.name}" activation has no session reinjector wired — body not injected.`,
                    },
                ],
                details: { skillName: skill.name, found: true, runAs: "inline" },
            };
        },
    };
}
