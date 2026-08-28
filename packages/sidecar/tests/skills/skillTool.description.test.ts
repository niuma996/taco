/**
 * SkillTool description wiring for skillAuthoringGuidance.
 *
 * The guidance string (where to put a new SKILL.md, which frontmatter keys
 * taco reads) is appended to the tool description rather than shown in a
 * system-prompt section, so it only costs tokens in sessions that actually
 * have the `skill` tool. Falsy input (undefined or "") must leave the base
 * description untouched — callers without a workspace-resolved guidance
 * string (tests, `getListingTools` before construction) should not see a
 * broken or dangling append.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-agent-core";
import { createSkillTool } from "../../src/skills/skillTool.ts";

const NO_SKILLS: Skill[] = [];
const getNoSkills = (): Skill[] => NO_SKILLS;
const baseOptions = {
    parentSessionId: "sess-1",
    getReinjector: () => undefined,
};

describe("createSkillTool description", () => {
    it("omits the guidance block when skillAuthoringGuidance is undefined", () => {
        const tool = createSkillTool(getNoSkills, baseOptions);
        assert.ok(!tool.description.includes("<skill_authoring>"));
    });

    it("omits the guidance block when skillAuthoringGuidance is an empty string", () => {
        const tool = createSkillTool(getNoSkills, { ...baseOptions, skillAuthoringGuidance: "" });
        assert.ok(!tool.description.includes("<skill_authoring>"));
    });

    it("appends the guidance block verbatim when provided", () => {
        const guidance = "<skill_authoring>\nput it in /tmp/skills\n</skill_authoring>";
        const tool = createSkillTool(getNoSkills, {
            ...baseOptions,
            skillAuthoringGuidance: guidance,
        });
        assert.ok(tool.description.includes(guidance));
        assert.ok(tool.description.includes("Invoke a skill"), "base description still present");
    });
});
