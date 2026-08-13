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

import type { Skill } from "@earendil-works/pi-agent-core";

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
    const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
    if (visibleSkills.length === 0) return "";

    const lines = [
        "The following skills provide specialized instructions for specific tasks.",
        "Use the <skill> tool to invoke a skill when the task matches its description.",
        "Skill body content is injected into context after the tool call — you will see <skill_body:NAME> blocks when a skill is active.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of the skill file) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ];

    for (const skill of visibleSkills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }

    lines.push("</available_skills>");
    return lines.join("\n");
}
