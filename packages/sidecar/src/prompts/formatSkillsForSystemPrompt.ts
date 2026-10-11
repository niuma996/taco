/**
 * formatSkillsForSystemPrompt — TACO skill listing for the system prompt.
 *
 * Overrides pi-agent-core's version so we can:
 *  - Replace the "Use the read tool" guidance with Skill tool guidance
 *  - List tool names alongside descriptions to help the LLM discover the skill tool
 *
 * Output shape matches the agentskills.io <available_skills> XML format so it
 * remains compatible with any tooling that expects that structure.
 */

import type { Skill } from "../runtime/pi/types.ts";

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export interface FormatSkillsOptions {
    /**
     * Emit each skill's `<location>` (absolute file path) and the guidance for
     * resolving a skill's relative references against it. Defaults to `true`.
     *
     * Pass `false` when the session has no file-reading tool. The path is
     * then unusable — invoking a skill needs only its name, and the body is
     * injected server-side — while still exposing an absolute host path, which
     * on an IM channel reaches a third party.
     */
    readonly includeLocation?: boolean;
}

export function formatSkillsForSystemPrompt(
    skills: Skill[],
    options: FormatSkillsOptions = {},
): string {
    const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
    if (visibleSkills.length === 0) return "";
    const includeLocation = options.includeLocation ?? true;

    const lines = [
        "The following skills provide specialized instructions for specific tasks.",
        "Use the `skill` tool to invoke a skill when the task matches its description.",
        'Skill body content is injected into context after the tool call — you will see <skill_body name="NAME"> blocks when a skill is active.',
        ...(includeLocation
            ? [
                  "When a skill file references a relative path, resolve it against the skill directory (parent of the skill file) and use that absolute path in tool commands.",
              ]
            : []),
        "",
        "<available_skills>",
    ];

    for (const skill of visibleSkills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        if (includeLocation) lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }

    lines.push("</available_skills>");
    return lines.join("\n");
}
