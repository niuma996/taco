import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dedupeSkillsByName } from "../../src/skills/dedupeSkills.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

function mkSkill(name: string, origin: string): TacoSkill {
    return {
        name,
        description: `${name} from ${origin}`,
        filePath: `/fake/${origin}/${name}/SKILL.md`,
        content: `${name} content`,
        source: origin === "builtin" ? "builtin" : "user",
    };
}

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
