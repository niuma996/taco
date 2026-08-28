/**
 * skillAuthoringGuidance — tells the model where a new skill file should go
 * and which frontmatter fields taco actually reads.
 *
 * Neither fact is derivable without reading source. `defaultSkillDirs` is the
 * single source of truth for the five-path search order, but it exists only
 * as code + comments — nothing renders it for the model. Likewise
 * `runAs` / `inlineOnly` / `allowedTools` / `model` are taco-private
 * frontmatter keys that pi-agent-core's `loadSourcedSkills` silently drops;
 * they are re-parsed by `skillFrontmatter.ts`, but a user (especially one
 * without the source tree) has no way to discover they exist.
 *
 * Rendered from `defaultSkillDirs` rather than duplicated as a hardcoded
 * string — same rationale as `agent.ts`'s `AgentTypeDescriptor` hints: a
 * blurb that repeats the directory list drifts from the function the moment
 * either one changes, and only one side can be caught by a test.
 */

import { defaultSkillDirs } from "../config/config.ts";

/**
 * Render the "where do I put a new skill" + "what frontmatter does taco read"
 * block. Always non-empty — unlike `formatSkillsForSystemPrompt`, there is no
 * "zero skills" case that would make this section noise: the guidance is
 * about the mechanism, not the current listing, so it is worth showing even
 * to a workspace with no skills yet.
 *
 * `cwd` should be `executionCwd`, not `sessionCwd` — for IM workspaces the two
 * diverge (session storage vs. scratch/local-binding), and `defaultSkillDirs`
 * is what actually gets scanned against the execution location.
 */
export function formatSkillAuthoringGuidance(cwd: string): string {
    const dirs = defaultSkillDirs(cwd);
    const writable: string[] = [];
    let builtin: string | undefined;
    for (const dir of dirs) {
        switch (dir.source) {
            case "user":
                writable.push(dir.path);
                break;
            case "builtin":
                builtin = dir.path;
                break;
            default: {
                // Exhaustiveness check: SkillDirInput.source is a 2-value union
                // today. Adding a third value without handling it here fails
                // this assignment at compile time instead of silently
                // dropping the new dir from both `writable` and the
                // read-only callout below.
                const _exhaustive: never = dir.source;
                return _exhaustive;
            }
        }
    }

    const lines = [
        "<skill_authoring>",
        "To add a new skill, create SKILL.md in one of these directories (checked in order, first match by name wins):",
        ...writable.map((p, i) => `  ${i + 1}. ${p}`),
    ];
    if (builtin) {
        lines.push(
            `Do not write to ${builtin} — it ships with taco and is read-only (upgrades overwrite it).`,
        );
    }
    lines.push(
        "",
        "SKILL.md needs YAML frontmatter with at least `name` and `description`. taco also reads these " +
            "taco-specific keys, which a generic skill-authoring guide will not mention:",
        '  - runAs: "inline" | "subagent" (default "inline"). inline injects the body into the current ' +
            "session; subagent runs it in a sandboxed child session.",
        "  - inlineOnly: true — refuses subagent-mode invocation. Required for any skill whose body " +
            "instructs the model to call tools that only make sense in the calling session (e.g. dispatching " +
            "more `agent` calls) — a subagent cannot route those back to the parent.",
        "  - allowedTools: string[] — restricts the toolset for subagent mode.",
        "  - model: string — overrides the model for subagent mode.",
        "Changes to SKILL.md in these user-writable directories take effect automatically shortly after " +
            "saving. An already-open session can invoke a new or changed skill by name, but start a new " +
            "session before expecting <available_skills> to list a newly-created skill.",
        "</skill_authoring>",
    );
    return lines.join("\n");
}
