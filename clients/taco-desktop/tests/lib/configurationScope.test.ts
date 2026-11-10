import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentEntry, SkillEntry } from "@taco-ai/protocol";
import { filterAgentScope, filterSkillScope } from "../../src/lib/configurationScope";

const agents: AgentEntry[] = [
    { agentType: "shared", description: "global", source: "user", scope: "global", editable: true },
    {
        agentType: "shared",
        description: "workspace",
        source: "user",
        scope: "workspace",
        editable: true,
    },
    { agentType: "builtin", description: "built in", source: "builtin", editable: false },
];

const skills: SkillEntry[] = [
    { name: "shared", description: "global", source: "user", scope: "global", filePath: "/g" },
    { name: "local", description: "workspace", source: "user", scope: "workspace", filePath: "/w" },
    { name: "builtin", description: "built in", source: "builtin", filePath: "/b" },
];

describe("configuration scope filtering", () => {
    it("shows only directly owned entries in global and workspace views", () => {
        assert.deepEqual(
            filterAgentScope(agents, "global").map((a) => a.description),
            ["global"],
        );
        assert.deepEqual(
            filterAgentScope(agents, "workspace").map((a) => a.description),
            ["workspace"],
        );
        assert.deepEqual(
            filterSkillScope(skills, "global").map((s) => s.name),
            ["shared"],
        );
        assert.deepEqual(
            filterSkillScope(skills, "workspace").map((s) => s.name),
            ["local"],
        );
    });

    it("keeps the effective catalog and filters the builtin source", () => {
        assert.equal(filterAgentScope(agents, "builtin").length, 1);
        assert.equal(filterAgentScope(agents, "effective").length, 3);
        assert.equal(filterSkillScope(skills, "builtin").length, 1);
        assert.equal(filterSkillScope(skills, "effective").length, 3);
    });
});
