import type { AgentEntry, CatalogScope, SkillEntry } from "@taco-ai/protocol";

/** Source layers are independent of filesystem or IM target selection. */
export type ConfigurationScope = "effective" | CatalogScope;
export type ConfigurationScopeVariant = "catalog" | "runtime" | "target";

export function filterAgentScope<T extends Pick<AgentEntry, "scope" | "source">>(
    agents: readonly T[],
    scope: ConfigurationScope,
): T[] {
    if (scope === "builtin") return agents.filter((agent) => agent.source === "builtin");
    if (scope === "global" || scope === "workspace") {
        return agents.filter((agent) => agent.scope === scope);
    }
    return [...agents];
}

export function filterSkillScope<T extends Pick<SkillEntry, "scope" | "source">>(
    skills: readonly T[],
    scope: ConfigurationScope,
): T[] {
    if (scope === "builtin") return skills.filter((skill) => skill.source === "builtin");
    if (scope === "global" || scope === "workspace") {
        return skills.filter((skill) => skill.scope === scope);
    }
    return [...skills];
}
