/**
 * create-skill builtin skill — structural load test.
 *
 * The body teaches the runtime's own skill-creation loop, so the test's job
 * is to guard that the body stays in sync with the infrastructure it points
 * at: the path guidance, hot-reload behavior, and skills.list diagnostics. If
 * any of those drift (e.g., we add or rename a frontmatter key, or change the
 * reload trigger), the skill starts teaching something false.
 *
 * Body-prose assertions are intentionally NOT included here — they drift with
 * any wording change and don't exercise code. The runtime's behaviour is
 * guarded by skillFrontmatter, skillDiagnostics, and loader tests.
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
const SKILL_PATH = join(HERE, "..", "..", "src", "skills", "builtin", "create-skill", "SKILL.md");

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("create-skill builtin skill", () => {
    it("exists on disk at the canonical builtin path", () => {
        assert.ok(body().length > 0, "SKILL.md must not be empty");
    });

    it("frontmatter declares name + description, no runAs (default inline)", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(fm.name, "create-skill");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be a non-empty string so the skill surfaces in the prompt",
        );
        assert.ok(
            fm.description.toLowerCase().startsWith("use when"),
            "description must lead with the trigger phrase so the model knows when to reach for it",
        );
        // Length stays under pi's 1024-char ceiling so the loader won't flag it.
        assert.ok(fm.description.length <= 1024, "description must fit pi's ceiling");
        // Default runAs is inline; assert nothing declares otherwise — the
        // skill doesn't dispatch subagents and shouldn't be subagent-only.
        assert.equal(
            fm.runAs,
            undefined,
            "create-skill should not override runAs; default inline is correct",
        );
        assert.equal(
            fm.inlineOnly,
            undefined,
            "create-skill should not be inlineOnly — it doesn't dispatch subagents",
        );
    });

    it("directory name matches the frontmatter name (pi loads SKILL.md under a directory named after the skill)", () => {
        const fm = parseYamlFrontmatter(body());
        const parentDir = SKILL_PATH.split("/").slice(-2, -1)[0];
        assert.equal(parentDir, fm.name, "parent directory must equal frontmatter name");
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path and uses no taco-private keys", () => {
        const skill: Skill = {
            name: "create-skill",
            description: "stub",
            filePath: SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(SKILL_PATH);
        // If taco-private keys get added here, this test will surface them —
        // the meta-skill should use defaults, not override them.
        assert.equal(fm.runAs, undefined);
        assert.equal(fm.inlineOnly, undefined);
        assert.equal(fm.allowedTools, undefined);
        assert.equal(fm.model, undefined);
    });

    it("stays within a workable size band — substantive but not superpowers-verbose", () => {
        // Lower bound guards against the body being trimmed back into a
        // checklist that teaches nothing about scripts; upper bound guards
        // against it growing into a 26k treatise.
        const words = body().split(/\s+/).filter(Boolean).length;
        assert.ok(words > 400, `expected >400 words (substantive), got ${words}`);
        assert.ok(words < 1100, `expected <1100 words (still lean), got ${words}`);
    });
});
