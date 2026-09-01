/**
 * dedupeSkillsByName / dedupeSkillsByNameWithDuplicates — first-match-wins
 * dedup. `dedupeSkillsByNameWithDuplicates` additionally reports what the
 * first-match-wins pass discarded, so a name collision is observable at load.
 */

import { strict as assert } from "node:assert";
import assertStrict from "node:assert/strict";
import { describe, it } from "node:test";
import {
    dedupeSkillsByName,
    dedupeSkillsByNameWithDuplicates,
} from "../../src/skills/dedupeSkills.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

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

const mkSkill = (name: string, origin: string): TacoSkill => ({
    name,
    description: `${name} from ${origin}`,
    filePath: `/fake/${origin}/${name}/SKILL.md`,
    content: `${name} content`,
    source: origin === "builtin" ? "builtin" : "user",
});

describe("dedupeSkillsByName", () => {
    it("returns empty array for empty input", () => {
        assert.deepEqual(dedupeSkillsByName([]), []);
    });

    it("keeps all skills when names are unique", () => {
        const input = [mkSkill("a", "x"), mkSkill("b", "x")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 2);
        assert.deepEqual(
            out.map((s) => s.name),
            ["a", "b"],
        );
    });

    it("keeps first occurrence on duplicate name (first-wins)", () => {
        const input = [mkSkill("foo", "taco"), mkSkill("foo", "claude"), mkSkill("foo", "pi")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 1);
        assert.equal(out[0].description, "foo from taco"); // first-wins
    });

    it("preserves the source field of the winning skill on duplicate name", () => {
        // user skill listed before builtin (defaultSkillDirs semantics), first-wins preserves user.
        const input = [mkSkill("foo", "user-dir"), mkSkill("foo", "builtin")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 1);
        assert.equal(out[0].source, "user");
    });

    it("does not mutate input", () => {
        const input = [mkSkill("a", "x"), mkSkill("a", "y")];
        const inputLen = input.length;
        dedupeSkillsByName(input);
        assert.equal(input.length, inputLen);
    });
});

describe("dedupeSkillsByNameWithDuplicates", () => {
    it("reports a builtin shadowed by a user skill, keeping the user one", () => {
        // defaultSkillDirs order: user dirs first, builtin last.
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("deep-review"),
            builtinSkill("deep-review"),
        ]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(kept[0].source, "user", "user skill must win");
        assertStrict.equal(duplicates.length, 1);
        assertStrict.equal(duplicates[0].name, "deep-review");
        assertStrict.equal(duplicates[0].dropped.source, "builtin");
        assertStrict.equal(duplicates[0].keptFrom.source, "user");
    });

    it("reports a collision between two user dirs", () => {
        const first = userSkill("shared", "/work/.taco/skills");
        const second = userSkill("shared", "/home/me/.claude/skills");
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([first, second]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(kept[0].filePath, first.filePath);
        assertStrict.equal(duplicates.length, 1);
        assertStrict.equal(duplicates[0].dropped.filePath, second.filePath);
        assertStrict.equal(duplicates[0].keptFrom.filePath, first.filePath);
    });

    it("reports every loser when one name appears three times", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("triple", "/a"),
            userSkill("triple", "/b"),
            userSkill("triple", "/c"),
        ]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(duplicates.length, 2);
        // Both losers point at the same winner, not at each other — otherwise a
        // UI would tell the user to look at a file that was itself discarded.
        assertStrict.deepEqual(
            duplicates.map((d) => d.keptFrom.filePath),
            ["/a/triple/SKILL.md", "/a/triple/SKILL.md"],
        );
    });

    it("returns an empty duplicates array when all names are unique", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("alpha"),
            userSkill("beta"),
        ]);
        assertStrict.equal(kept.length, 2);
        assertStrict.deepEqual(duplicates, []);
    });

    it("handles an empty input", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([]);
        assertStrict.deepEqual(kept, []);
        assertStrict.deepEqual(duplicates, []);
    });
});
