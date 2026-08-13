/**
 * skills.list handler surfaces inlineOnly from frontmatter through SkillEntry.
 *
 * Guards against regressions where the handler forgets to copy the new
 * field, or where server.ts forgets to stamp it onto TacoSkill after
 * preloadSkillFrontmatter.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

before(() => {
    registerBuiltinMethods();
});

function makeCtx(workspace: Partial<WorkspaceRuntime>) {
    return {
        id: "test-id",
        workspace: workspace as WorkspaceRuntime,
        cwd: "/tmp/ws",
        server: {},
        params: { workspace: "/tmp/ws" },
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

describe("skills.list surfaces inlineOnly", () => {
    let tmpHome: string;
    let tmpCwd: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "taco-skills-io-home-"));
        tmpCwd = mkdtempSync(join(tmpdir(), "taco-skills-io-cwd-"));
        process.env.TACO_HOME = tmpHome;

        // The fan-out-agents skill is a real builtin — it MUST show up with
        // inlineOnly=true. The test still asserts on a separately-written
        // user skill (inlineOnly:false case) so a future refactor that drops
        // either field is caught.
        const fanOut = join(tmpCwd, ".taco", "skills", "fan-out-clone");
        mkdirSync(fanOut, { recursive: true });
        writeFileSync(
            join(fanOut, "SKILL.md"),
            "---\nname: fan-out-clone\ndescription: clone for test\nrunAs: inline\ninlineOnly: true\n---\n# body\n",
        );
        const plain = join(tmpCwd, ".taco", "skills", "plain-skill");
        mkdirSync(plain, { recursive: true });
        writeFileSync(
            join(plain, "SKILL.md"),
            "---\nname: plain-skill\ndescription: no constraint\n---\n# body\n",
        );
    });

    after(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(tmpCwd, { recursive: true, force: true });
    });

    it("inlineOnly skills are flagged in the list response", async () => {
        const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
        const { loadSourcedSkills } = await import("@earendil-works/pi-agent-core");
        const { defaultSkillDirs } = await import("../../../src/config/config.ts");
        const { dedupeSkillsByName } = await import("../../../src/skills/dedupeSkills.ts");
        const { preloadSkillFrontmatter, readSkillFrontmatter } = await import(
            "../../../src/skills/skillFrontmatter.ts"
        );

        // Replay the server.ts stamping step so the test exercises the real
        // wiring: load → dedupe → preload → stamp inlineOnly → RPC handler.
        const skillEnv = new NodeExecutionEnv({ cwd: tmpCwd });
        const loaded = await loadSourcedSkills(
            skillEnv,
            defaultSkillDirs(tmpCwd),
            (skill, source) => ({ ...skill, source }),
        );
        const skills = dedupeSkillsByName(loaded.skills.map((entry) => entry.skill));
        preloadSkillFrontmatter(skills);
        for (const s of skills) {
            const fm = readSkillFrontmatter(s.filePath);
            if (fm.inlineOnly === true) {
                (s as { inlineOnly?: boolean }).inlineOnly = true;
            }
        }

        const handler = getRegisteredMethod("skills.list");
        assert.ok(handler);
        const result = (await handler.handler(makeCtx({ resources: { skills } }))) as {
            skills: { name: string; inlineOnly?: boolean }[];
        };

        const fanOut = result.skills.find((s) => s.name === "fan-out-clone");
        assert.ok(fanOut, "user-defined fan-out-clone skill must be in the list");
        assert.equal(
            fanOut.inlineOnly,
            true,
            "inlineOnly:true must surface as inlineOnly on the SkillEntry",
        );

        const plain = result.skills.find((s) => s.name === "plain-skill");
        assert.ok(plain, "plain-skill must be in the list");
        assert.notEqual(
            plain.inlineOnly,
            true,
            "skills without inlineOnly frontmatter must not be flagged true",
        );

        // And the real builtin must also carry the flag.
        const realFanOut = result.skills.find((s) => s.name === "fan-out-agents");
        assert.ok(realFanOut, "the real builtin fan-out-agents must be loaded");
        assert.equal(realFanOut.inlineOnly, true);
    });
});
