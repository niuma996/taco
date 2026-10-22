/** Consolidated from 2 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SkillDiagnosticEntry } from "@taco-ai/protocol";
import { harnessContext } from "../../../src/lib/harnessContext.ts";
import { SlashNormalizedExecutionEnv } from "../../../src/runtime/harness/slashNormalizedEnv.ts";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { dedupeSkillsByNameWithDuplicates } from "../../../src/skills/dedupeSkills.ts";
import {
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
} from "../../../src/skills/skillDiagnostics.ts";
import { preloadSkillFrontmatter } from "../../../src/skills/skillFrontmatter.ts";
import type { TacoSkill } from "../../../src/skills/tacoSkill.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("skills.diagnostics", () => {
    /**
     * skills.list — surfaces load diagnostics and omits the key when empty.
     *
     * The "omits when empty" property is load-bearing: clients written before this
     * field existed must continue to receive a byte-identical result in the
     * common (no warnings) case. This test pins that.
     */

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
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
    }

    /** Replays the relevant slice of SidecarServer.loadSkills for handler tests. */
    async function reloadFromDisk(tmpCwd: string): Promise<{
        skills: TacoSkill[];
        diagnostics: SkillDiagnosticEntry[];
    }> {
        const { loadSourcedSkills } = await import("@taco-ai/pi-harness");
        const { defaultSkillDirs } = await import("../../../src/config/config.ts");
        const skillEnv = new SlashNormalizedExecutionEnv({ cwd: tmpCwd });
        const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
            skillEnv,
            defaultSkillDirs(tmpCwd),
            (skill, source): TacoSkill => ({ ...skill, source }),
            harnessContext,
        );
        const deduped = dedupeSkillsByNameWithDuplicates(loaded.skills.map((e) => e.skill));
        preloadSkillFrontmatter(deduped.kept);
        for (const s of deduped.kept) {
            const fm = await import("../../../src/skills/skillFrontmatter.ts");
            const frontmatter = fm.readSkillFrontmatter(s.filePath);
            if (frontmatter.inlineOnly === true) {
                (s as { inlineOnly?: boolean }).inlineOnly = true;
            }
        }
        return {
            skills: deduped.kept,
            diagnostics: [
                ...mapLoaderDiagnostics(loaded.diagnostics),
                ...mapDuplicateDiagnostics(deduped.duplicates),
            ],
        };
    }

    describe("skills.list diagnostics", () => {
        const tmpHome = useTempTacoHome("skills-diag");
        let tmpCwd: string;
        let tmpUserHome: string;
        let prevHome: string | undefined;

        before(() => {
            prevHome = process.env.HOME;
            tmpCwd = mkdtempSync(join(tmpdir(), "taco-skills-diag-cwd-"));
            // Isolate $HOME too: defaultSkillDirs reads ~/.claude/skills and
            // ~/.pi/skills via os.homedir(), so without this the scan picks up the
            // developer's real user skills. A personal skill sharing a name with a
            // builtin would then surface here as a duplicate_name diagnostic and
            // fail the "omit when empty" assertion for an unrelated reason.
            tmpUserHome = mkdtempSync(join(tmpdir(), "taco-skills-diag-userhome-"));
            process.env.HOME = tmpUserHome;

            // Two user skills plus a third that collides with the second name, so a
            // single scan produces both kinds of warning.
            const ok1 = join(tmpCwd, ".taco", "skills", "ok-one");
            mkdirSync(ok1, { recursive: true });
            writeFileSync(
                join(ok1, "SKILL.md"),
                "---\nname: ok-one\ndescription: ok\n---\n# body\n",
            );

            const ok2 = join(tmpCwd, ".taco", "skills", "ok-two");
            mkdirSync(ok2, { recursive: true });
            writeFileSync(
                join(ok2, "SKILL.md"),
                "---\nname: ok-two\ndescription: ok\n---\n# body\n",
            );

            // A same-name second user skill in a different dir to trigger duplicate_name.
            // TACO_HOME is a separate user dir (third in the search order), so
            // writing here puts a second file whose name collides with ok-two.
            const clash = join(tmpHome, "skills", "ok-two");
            mkdirSync(clash, { recursive: true });
            writeFileSync(join(clash, "SKILL.md"), "---\nname: ok-two\ndescription: clash\n---\n");

            // A genuinely broken file for the parse_failed diagnostic.
            const broken = join(tmpCwd, ".taco", "skills", "broken");
            mkdirSync(broken, { recursive: true });
            writeFileSync(join(broken, "SKILL.md"), "---\nname: broken\nbad: [unclosed\n---\n");
        });

        after(() => {
            if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME");
            else process.env.HOME = prevHome;
            rmSync(tmpCwd, { recursive: true, force: true });
            rmSync(tmpUserHome, { recursive: true, force: true });
        });

        it("omits the diagnostics key when there are no warnings", async () => {
            const { skills, diagnostics } = await reloadFromDisk("/clean/cwd");
            const handler = getRegisteredMethod("skills.list");
            assert.ok(handler);

            const res = (await handler.handler(
                makeCtx({
                    resources: { skills },
                    skillDiagnostics: diagnostics,
                }),
            )) as Record<string, unknown>;

            assert.ok("skills" in res, "skills key must always be present");
            assert.ok(
                !("diagnostics" in res),
                "diagnostics must be omitted entirely when there are none, not sent as []",
            );
        });

        it("includes diagnostics when present, with both kinds surfaced", async () => {
            const { skills, diagnostics } = await reloadFromDisk(tmpCwd);
            assert.ok(diagnostics.length >= 2, "expected at least a duplicate + a parse failure");
            const codes = diagnostics.map((d) => d.code);
            assert.ok(codes.includes("duplicate_name"), "collision must be reported");
            assert.ok(
                codes.includes("parse_failed"),
                "broken SKILL.md must surface its own diagnostic",
            );

            const handler = getRegisteredMethod("skills.list");
            assert.ok(handler);
            const res = (await handler.handler(
                makeCtx({
                    resources: { skills },
                    skillDiagnostics: diagnostics,
                }),
            )) as { diagnostics?: SkillDiagnosticEntry[] };

            assert.ok(Array.isArray(res.diagnostics));
            assert.ok(res.diagnostics.length >= 2);
            // Same content as the workspace stored — no rewriting, no field loss.
            for (const d of diagnostics) {
                assert.ok(
                    res.diagnostics.some((r) => r.code === d.code && r.path === d.path),
                    `expected diagnostic for ${d.path} (${d.code}) to round-trip`,
                );
            }
        });
    });
});

describe("skills.inlineOnly", () => {
    /**
     * skills.list handler surfaces inlineOnly from frontmatter through SkillEntry.
     *
     * Guards against regressions where the handler forgets to copy the new
     * field, or where server.ts forgets to stamp it onto TacoSkill after
     * preloadSkillFrontmatter.
     */

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
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
    }

    describe("skills.list surfaces inlineOnly", () => {
        useTempTacoHome("skills-io");
        let tmpCwd: string;
        let tmpUserHome: string;
        let prevHome: string | undefined;

        before(() => {
            prevHome = process.env.HOME;
            tmpCwd = mkdtempSync(join(tmpdir(), "taco-skills-io-cwd-"));
            // Isolate $HOME: defaultSkillDirs reads ~/.claude/skills and ~/.pi/skills
            // via os.homedir(), and the assertion below pins the real builtin
            // fan-out-agents. A personal skill of the same name would shadow it.
            tmpUserHome = mkdtempSync(join(tmpdir(), "taco-skills-io-userhome-"));
            process.env.HOME = tmpUserHome;

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
            if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME");
            else process.env.HOME = prevHome;
            rmSync(tmpCwd, { recursive: true, force: true });
            rmSync(tmpUserHome, { recursive: true, force: true });
        });

        it("inlineOnly skills are flagged in the list response", async () => {
            const { loadSourcedSkills } = await import("@taco-ai/pi-harness");
            const { defaultSkillDirs } = await import("../../../src/config/config.ts");
            const { SlashNormalizedExecutionEnv } = await import(
                "../../../src/runtime/harness/slashNormalizedEnv.ts"
            );
            const { dedupeSkillsByName } = await import("../../../src/skills/dedupeSkills.ts");
            const { preloadSkillFrontmatter, readSkillFrontmatter } = await import(
                "../../../src/skills/skillFrontmatter.ts"
            );

            // Replay the server.ts stamping step so the test exercises the real
            // wiring: load → dedupe → preload → stamp inlineOnly → RPC handler.
            // Uses the same SlashNormalizedExecutionEnv as server.ts so the Windows
            // path-separator fix is on the path under test.
            const skillEnv = new SlashNormalizedExecutionEnv({ cwd: tmpCwd });
            const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
                skillEnv,
                defaultSkillDirs(tmpCwd),
                (skill, source): TacoSkill => ({ ...skill, source }),
                harnessContext,
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
});
