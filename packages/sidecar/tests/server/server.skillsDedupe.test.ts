/**
 * Verifies the server skill-loading path: loadSourcedSkills(defaultSkillDirs) →
 * dedupeSkillsByName actually dedupes same-named skills with project
 * <cwd>/.taco/skills winning (first-wins dedup, project source is first,
 * builtin is last as fallback).
 *
 * Builds the composed pipeline directly rather than spinning up a full
 * SidecarServer. Uses TACO_HOME (not the real ~/.claude) as the "loses"
 * source so the test stays hermetic.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadSourcedSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { defaultSkillDirs } from "../../src/config/config.ts";
import { dedupeSkillsByName } from "../../src/skills/dedupeSkills.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

function writeSkill(dir: string, name: string, description: string): void {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body\n`,
    );
}

async function loadDeduped(cwd: string): Promise<TacoSkill[]> {
    const skillEnv = new NodeExecutionEnv({ cwd });
    const loaded = await loadSourcedSkills(skillEnv, defaultSkillDirs(cwd), (skill, source) => ({
        ...skill,
        source,
    }));
    return dedupeSkillsByName(loaded.skills.map((entry) => entry.skill));
}

describe("server.ts skill-loading path: loadSourcedSkills + dedupeSkillsByName", () => {
    let tmpHome: string;
    let tmpCwd: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "taco-server-skills-home-"));
        tmpCwd = mkdtempSync(join(tmpdir(), "taco-server-skills-cwd-"));
        process.env.TACO_HOME = tmpHome;

        // $TACO_HOME/skills/foo — global taco source (lower priority than project)
        writeSkill(join(tmpHome, "skills"), "foo", "foo from taco global");
        // <cwd>/.taco/skills/foo — project source, highest priority per
        // defaultSkillDirs order, same name as the global one above
        writeSkill(join(tmpCwd, ".taco", "skills"), "foo", "foo from project taco");
        // a uniquely-named skill so we can confirm non-duplicates survive
        writeSkill(join(tmpCwd, ".taco", "skills"), "bar", "bar unique");
    });

    after(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(tmpCwd, { recursive: true, force: true });
    });

    it("dedupes same-named skill across sources, project <cwd>/.taco wins by first-wins order", async () => {
        const deduped = await loadDeduped(tmpCwd);

        const fooSkills = deduped.filter((s) => s.name === "foo");
        assert.equal(fooSkills.length, 1, "only one 'foo' skill should remain after dedupe");
        assert.equal(
            fooSkills[0].description,
            "foo from project taco",
            "<cwd>/.taco/skills is first in defaultSkillDirs, so it wins over $TACO_HOME/skills",
        );
        assert.equal(fooSkills[0].source, "user");

        const barSkills = deduped.filter((s) => s.name === "bar");
        assert.equal(barSkills.length, 1, "unique skill 'bar' is untouched by dedupe");
        assert.equal(barSkills[0].source, "user");
    });

    it("loads the real builtin skills directory and tags entries source: builtin", async () => {
        const deduped = await loadDeduped(tmpCwd);
        const builtinSkills = deduped.filter((s) => s.source === "builtin");
        // Asserts the directory is wired and readable, without naming a
        // specific skill — the builtin set changes as skills are added and
        // renamed, and pinning a name makes this test fail for the wrong reason.
        assert.ok(
            builtinSkills.length > 0,
            `expected at least one skill from skills/builtin/, got ${builtinSkills.length}`,
        );
    });

    it("lets a user-provided skill override a builtin skill of the same name", async () => {
        // Shadow whichever builtin actually exists rather than a hard-coded
        // name: a name that matches no builtin would make this pass while
        // testing nothing (there would be no duplicate to resolve).
        const builtinName = (await loadDeduped(tmpCwd)).find((s) => s.source === "builtin")?.name;
        assert.ok(builtinName, "need at least one builtin skill to shadow");

        // <cwd>/.taco/skills is the first array entry = highest priority, so
        // first-wins dedup should keep the user version over the builtin.
        writeSkill(join(tmpCwd, ".taco", "skills"), builtinName, "user override");
        const deduped = await loadDeduped(tmpCwd);
        const matches = deduped.filter((s) => s.name === builtinName);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].source, "user");
        assert.equal(matches[0].description, "user override");
    });
});
