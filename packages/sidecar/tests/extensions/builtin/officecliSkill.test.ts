/**
 * officecli bundled skill — structural load test.
 *
 * Guards against the skill being removed or its frontmatter drifting away
 * from the trigger-style description that the rest of taco's builtin skills
 * use. The skill ships with the officeCli extension (declared via
 * `BuiltinManifest.skillDirs`), so it lives under the extension's own
 * directory rather than skills/builtin/. Body content is vendored from
 * upstream and kept verbatim (see the provenance note in SKILL.md), so the
 * test does not assert on body prose — that drifts with every officecli
 * release and is owned upstream.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Skill } from "../../../src/runtime/pi/types.ts";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../../src/skills/skillFrontmatter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(
    HERE,
    "..",
    "..",
    "..",
    "src",
    "extensions",
    "builtin",
    "officeCli",
    "skills",
    "officecli",
    "SKILL.md",
);

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("officecli builtin skill", () => {
    it("exists on disk at the canonical builtin path", () => {
        assert.ok(body().length > 0, "SKILL.md must not be empty");
    });

    it("frontmatter declares name + description with a trigger-style lead", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(fm.name, "officecli");
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
    });

    it("directory name matches the frontmatter name (pi loads SKILL.md under a directory named after the skill)", () => {
        const fm = parseYamlFrontmatter(body());
        const parentDir = SKILL_PATH.split("/").slice(-2, -1)[0];
        assert.equal(parentDir, fm.name, "parent directory must equal frontmatter name");
    });

    it("frontmatter uses no taco-private keys — drives the model via shell, not subagent dispatch", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(
            fm.runAs,
            undefined,
            "officecli should not override runAs; the skill wraps a CLI the model shells out to, not a subagent flow",
        );
        assert.equal(
            fm.inlineOnly,
            undefined,
            "officecli should not be inlineOnly — it has no subagent-of-its-own dispatch to fence",
        );
        assert.equal(fm.allowedTools, undefined);
        assert.equal(fm.model, undefined);
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path", () => {
        const skill: Skill = {
            name: "officecli",
            description: "stub",
            filePath: SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(SKILL_PATH);
        assert.equal(fm.runAs, undefined);
        assert.equal(fm.inlineOnly, undefined);
    });
});
