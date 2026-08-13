/**
 * fan-out-agents builtin skill — static load test.
 *
 * Guards against the skill being removed or its frontmatter drifting away
 * from `runAs: inline` / `inlineOnly: true`. The skill is referenced by the
 * `taco-example` placeholder contract and by docs/superpowers plans; if the
 * builtin directory is reorganised, this test will fail loudly so the rename
 * is intentional rather than silent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, "..", "..", "src", "skills", "builtin", "fan-out-agents", "SKILL.md");

describe("fan-out-agents builtin skill", () => {
    it("exists on disk at the canonical builtin path", () => {
        const md = readFileSync(SKILL_PATH, "utf-8");
        assert.ok(md.length > 0, "SKILL.md must not be empty");
    });

    it("frontmatter declares name + description + runAs:inline + inlineOnly:true", () => {
        const md = readFileSync(SKILL_PATH, "utf-8");
        const fm = parseYamlFrontmatter(md);
        assert.equal(fm.name, "fan-out-agents");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be a non-empty string so the skill surfaces in the prompt",
        );
        assert.equal(fm.runAs, "inline", "must explicitly declare inline mode");
        assert.equal(
            fm.inlineOnly,
            true,
            "must declare inlineOnly so skillTool can hard-fence subagent invocation",
        );
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path", () => {
        const skill: Skill = {
            name: "fan-out-agents",
            description: "stub",
            filePath: SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(SKILL_PATH);
        assert.equal(fm.runAs, "inline");
        assert.equal(fm.inlineOnly, true);
    });

    it("body teaches parallel fan-out, not subagent dispatch from inside a subagent", () => {
        const md = readFileSync(SKILL_PATH, "utf-8");
        // Spot-check the body covers the contract the frontmatter implies.
        assert.ok(md.includes("`agent`"), "body must reference the `agent` tool");
        assert.ok(
            md.toLowerCase().includes("parallel") || md.includes("Promise.all"),
            "body must explain parallel execution",
        );
        assert.ok(
            md.includes("inline-only") || md.includes("inline only"),
            "body must restate the inline-only constraint for readers who skip the frontmatter",
        );
    });
});
