/**
 * createSkillTool's getSkills is a thunk, not a snapshot array — this is
 * the mechanism that makes skill hot reload work for sessions that are
 * already attached. SessionRegistry.updateSkills mutates the backing array
 * a tool was built with; the tool itself is never rebuilt. If execute() ever
 * closed over an array captured at createSkillTool-call time instead of
 * calling getSkills() again, an already-attached session would keep
 * resolving stale skills forever.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-agent-core";
import { createSkillTool } from "../../src/skills/skillTool.ts";

function mkSkill(name: string): Skill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/tmp/${name}/SKILL.md`,
        content: `# ${name}`,
    };
}

describe("createSkillTool live lookup", () => {
    it("re-reads getSkills() on every execute() call — later calls see a mutated backing list", async () => {
        let backing: Skill[] = [mkSkill("alpha")];
        const tool = createSkillTool(() => backing, {
            parentSessionId: "sess-1",
            getReinjector: () => undefined,
        });

        const first = await tool.execute("tc-1", { skill: "beta" }, undefined);
        assert.equal(first.details?.found, false, "beta should not resolve before the swap");

        // Simulate SessionRegistry.updateSkills swapping in a fresh scan —
        // no new tool is constructed, just the array the getter closes over.
        backing = [mkSkill("beta")];

        const second = await tool.execute("tc-2", { skill: "beta" }, undefined);
        assert.equal(second.details?.found, true, "beta should resolve after the swap");

        const third = await tool.execute("tc-3", { skill: "alpha" }, undefined);
        assert.equal(third.details?.found, false, "alpha should no longer resolve after the swap");
    });
});
