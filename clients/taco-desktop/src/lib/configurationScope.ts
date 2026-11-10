import type { AgentEntry, SkillEntry } from "@taco-ai/protocol";

/** Catalog views describe configuration layers; runtime views only choose a target. */
export type ConfigurationScope = "global" | "workspace" | "channel" | "effective";
export type ConfigurationScopeVariant = "catalog" | "runtime";

export function filterAgentScope<T extends Pick<AgentEntry, "scope">>(
    agents: readonly T[],
    scope: ConfigurationScope,
): T[] {
    if (scope === "global" || scope === "workspace") {
        return agents.filter((agent) => agent.scope === scope);
    }
    return [...agents];
}

export function filterSkillScope<T extends Pick<SkillEntry, "scope">>(
    skills: readonly T[],
    scope: ConfigurationScope,
): T[] {
    if (scope === "global" || scope === "workspace") {
        return skills.filter((skill) => skill.scope === scope);
    }
    return [...skills];
}
