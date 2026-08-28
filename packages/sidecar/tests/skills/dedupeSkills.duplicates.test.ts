/**
 * dedupeSkillsByNameWithDuplicates — reports what first-match-wins discarded.
 *
 * pi-agent-core's loader does not dedupe, so it emits no diagnostic for a
 * name collision; this function is the only place a shadowed skill is
 * observable. These tests also pin that the original `dedupeSkillsByName`
 * behavior is unchanged now that it delegates here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    dedupeSkillsByName,
    dedupeSkillsByNameWithDuplicates,
} from "../../src/skills/dedupeSkills.ts";

interface Fixture {
    name: string;
    filePath: string;
    source: "builtin" | "user";
}

const userSkill = (name: string, dir = "/work/.taco/skills"): Fixture => ({
    name,
    filePath: `${dir}/${name}/SKILL.md`,
    source: "user",
});
const builtinSkill = (name: string): Fixture => ({
    name,
    filePath: `/app/skills/builtin/${name}/SKILL.md`,
    source: "builtin",
});

describe("dedupeSkillsByNameWithDuplicates", () => {
    it("reports a builtin shadowed by a user skill, keeping the user one", () => {
        // defaultSkillDirs order: user dirs first, builtin last.
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("deep-review"),
            builtinSkill("deep-review"),
        ]);

        assert.equal(kept.length, 1);
        assert.equal(kept[0].source, "user", "user skill must win");
        assert.equal(duplicates.length, 1);
        assert.equal(duplicates[0].name, "deep-review");
        assert.equal(duplicates[0].dropped.source, "builtin");
        assert.equal(duplicates[0].keptFrom.source, "user");
    });

    it("reports a collision between two user dirs", () => {
        const first = userSkill("shared", "/work/.taco/skills");
        const second = userSkill("shared", "/home/me/.claude/skills");
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([first, second]);

        assert.equal(kept.length, 1);
        assert.equal(kept[0].filePath, first.filePath);
        assert.equal(duplicates.length, 1);
        assert.equal(duplicates[0].dropped.filePath, second.filePath);
        assert.equal(duplicates[0].keptFrom.filePath, first.filePath);
    });

    it("reports every loser when one name appears three times", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("triple", "/a"),
            userSkill("triple", "/b"),
            userSkill("triple", "/c"),
        ]);

        assert.equal(kept.length, 1);
        assert.equal(duplicates.length, 2);
        // Both losers point at the same winner, not at each other — otherwise a
        // UI would tell the user to look at a file that was itself discarded.
        assert.deepEqual(
            duplicates.map((d) => d.keptFrom.filePath),
            ["/a/triple/SKILL.md", "/a/triple/SKILL.md"],
        );
    });

    it("returns an empty duplicates array when all names are unique", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("alpha"),
            userSkill("beta"),
        ]);
        assert.equal(kept.length, 2);
        assert.deepEqual(duplicates, []);
    });

    it("handles an empty input", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([]);
        assert.deepEqual(kept, []);
        assert.deepEqual(duplicates, []);
    });
});

describe("dedupeSkillsByName (unchanged behavior after delegation)", () => {
    it("keeps first occurrence and preserves input order", () => {
        const out = dedupeSkillsByName([
            userSkill("a"),
            userSkill("b"),
            userSkill("a", "/other"),
            userSkill("c"),
        ]);
        assert.deepEqual(
            out.map((s) => s.name),
            ["a", "b", "c"],
        );
        assert.equal(out[0].filePath, "/work/.taco/skills/a/SKILL.md");
    });
});
