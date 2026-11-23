/**
 * Render skill locations from the same sources used by the loader so the
 * model's authoring guidance cannot drift from the scan order. Also describe
 * taco-specific frontmatter that pi's loader does not expose to the model.
 */

import {
    resolveWorkspaceConfigSources,
    type WorkspaceConfigSources,
} from "../config/workspaceConfigSources.ts";

/**
 * Render the "where do I put a new skill" + "what frontmatter does taco read"
 * block. Always non-empty — unlike `formatSkillsForSystemPrompt`, there is no
 * "zero skills" case that would make this section noise: the guidance is
 * about the mechanism, not the current listing, so it is worth showing even
 * to a workspace with no skills yet.
 *
 * `cwd` should be `executionCwd`, not `sessionCwd` — for IM workspaces the two
 * diverge (session storage vs. scratch/local-binding), and the source resolver
 * is what actually gets scanned against the execution location.
 */
export function formatSkillAuthoringGuidance(
    cwd: string,
    sources?: WorkspaceConfigSources,
): string {
    const dirs = (sources ?? resolveWorkspaceConfigSources(cwd)).skillDirs;
    const userLocations: string[] = [];
    let builtin: string | undefined;
    for (const dir of dirs) {
        switch (dir.source) {
            case "user":
                userLocations.push(dir.path);
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
        "Skill search locations (checked in order, first match by name wins):",
        ...userLocations.map((p, i) => `  ${i + 1}. ${p}`),
        "Search locations are not write grants. Prefer a project skill under .taco/skills/<name>/SKILL.md. " +
            "A local main session may also write under the runtime's $TACO_HOME/skills outside plan mode. " +
            "Other user search locations are writable only when already within the workspace or its associated directories. " +
            "IM and subagent sessions do not receive the global authoring grant. Follow plan-mode restrictions and runtime refusals.",
    ];
    if (builtin) {
        lines.push(
            `Do not write to ${builtin} — it ships with the runtime and is read-only (upgrades overwrite it).`,
        );
    }
    lines.push(
        "",
        "SKILL.md needs YAML frontmatter with at least `name` and `description`. The runtime also reads " +
            "these runtime-specific keys, which a generic skill-authoring guide will not mention:",
        '  - runAs: "inline" | "subagent" (default "inline"). inline injects the body into the current ' +
            "session; subagent runs it in a sandboxed child session.",
        "  - inlineOnly: true — refuses subagent-mode invocation. Required for any skill whose body " +
            "instructs the model to call tools that only make sense in the calling session (e.g. dispatching " +
            "more `agent` calls) — a subagent cannot route those back to the parent.",
        "  - allowedTools: string[] — restricts the toolset for subagent mode.",
        "  - model: string — overrides the model for subagent mode.",
        "  - whenToUse: string — a one-line hint shown in the system prompt's skill listing so the model " +
            "knows when to invoke this skill rather than guessing from `description` alone.",
        "Changes to SKILL.md in these user skill directories take effect automatically shortly after " +
            "saving. An already-open session can invoke a new or changed skill by name, but start a new " +
            "session before expecting <available_skills> to list a newly-created skill.",
        "</skill_authoring>",
    );
    return lines.join("\n");
}
