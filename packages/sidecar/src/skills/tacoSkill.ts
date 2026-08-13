/**
 * TacoSkill — extends pi-agent-core's Skill with a `source` tag.
 *
 * pi's Skill type carries no provenance. loadSourcedSkills (server.ts) attaches
 * `source` via its mapSkill callback so downstream consumers (skills.list RPC,
 * SkillsPane UI) can distinguish builtin from user-provided skills.
 */

import type { Skill } from "@earendil-works/pi-agent-core";

export type SkillSource = "builtin" | "user";

export interface TacoSkill extends Skill {
    source: SkillSource;
    /**
     * Mirrors `SkillFrontmatter.inlineOnly` — true when the skill refuses
     * subagent-mode invocation. Set by server.ts after `preloadSkillFrontmatter`
     * so it surfaces through `skills.list` and the SkillsPane can flag the
     * restriction in the UI. Runtime enforcement lives in `skillTool` and
     * `agentSpawner.spawnSkillSubagent`.
     */
    inlineOnly?: boolean;
}
