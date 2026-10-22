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

import type { TacoSkill } from "../skills/tacoSkill.ts";

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
    /**
     * Soft cap on the rendered `<available_skills>` block. If the full listing
     * exceeds this, it degrades to names + paths only. Defaults to 20,000 chars.
     */
    readonly metadataBudget?: number;
}

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
// Truncated separately, never as a merged string: a long description must not
// eat the whenToUse hint — the hint is what tells the model when to invoke.
const MAX_DESCRIPTION_CHARS = 250;
const MAX_WHEN_TO_USE_CHARS = 120;

export function formatSkillsForSystemPrompt(
    skills: TacoSkill[],
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

    const skillLines = visibleSkills.map((skill) => formatSkillLine(skill, includeLocation));
    const full = [...lines, ...skillLines, "</available_skills>"].join("\n");
    if (full.length <= (options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET)) {
        return full;
    }

    // Budget exceeded: degrade to names + paths so a large skill set does not
    // blow the system prompt budget. This mirrors ZCode's skillMetadataBudget.
    const degradedLines = visibleSkills.map((skill) =>
        [
            "  <skill>",
            `    <name>${escapeXml(skill.name)}</name>`,
            ...(includeLocation ? [`    <location>${escapeXml(skill.filePath)}</location>`] : []),
            "  </skill>",
        ].join("\n"),
    );
    return [
        ...lines.slice(0, 1),
        "Use the `skill` tool to invoke a skill when the task matches its description.",
        "Descriptions were omitted to fit the prompt budget — call `skill` with the name to load that skill's body.",
        "",
        "<available_skills>",
        ...degradedLines,
        "</available_skills>",
    ].join("\n");
}

/** Truncate to `max` chars with a trailing ellipsis. */
function truncateWithEllipsis(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function formatSkillLine(skill: TacoSkill, includeLocation: boolean): string {
    const description = truncateWithEllipsis(skill.description, MAX_DESCRIPTION_CHARS);
    // One-line contract, same as the agents catalog: collapse whitespace so a
    // multi-line frontmatter value cannot break the listing layout.
    const hint = skill.whenToUse
        ? truncateWithEllipsis(skill.whenToUse.replace(/\s+/g, " ").trim(), MAX_WHEN_TO_USE_CHARS)
        : undefined;
    const text = hint ? `${description} — ${hint}` : description;
    const parts = [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(text)}</description>`,
        ...(includeLocation ? [`    <location>${escapeXml(skill.filePath)}</location>`] : []),
        "  </skill>",
    ];
    return parts.join("\n");
}
