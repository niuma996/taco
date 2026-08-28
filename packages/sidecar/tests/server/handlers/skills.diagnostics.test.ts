/**
 * skills.list — surfaces load diagnostics and omits the key when empty.
 *
 * The "omits when empty" property is load-bearing: clients written before this
 * field existed must continue to receive a byte-identical result in the
 * common (no warnings) case. This test pins that.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SkillDiagnosticEntry } from "@taco-ai/protocol";
import { SlashNormalizedExecutionEnv } from "../../../src/runtime/slashNormalizedEnv.ts";
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

/** Replays the relevant slice of SidecarServer.loadSkills for handler tests. */
async function reloadFromDisk(tmpCwd: string): Promise<{
    skills: TacoSkill[];
    diagnostics: SkillDiagnosticEntry[];
}> {
    const { loadSourcedSkills } = await import("@earendil-works/pi-agent-core");
    const { defaultSkillDirs } = await import("../../../src/config/config.ts");
    const skillEnv = new SlashNormalizedExecutionEnv({ cwd: tmpCwd });
    const loaded = await loadSourcedSkills(
        skillEnv,
        defaultSkillDirs(tmpCwd),
        (skill, source) => ({ ...skill, source }) as TacoSkill,
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
    let tmpHome: string;
    let tmpCwd: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "taco-skills-diag-home-"));
        tmpCwd = mkdtempSync(join(tmpdir(), "taco-skills-diag-cwd-"));
        process.env.TACO_HOME = tmpHome;

        // Two user skills plus a third that collides with the second name, so a
        // single scan produces both kinds of warning.
        const ok1 = join(tmpCwd, ".taco", "skills", "ok-one");
        mkdirSync(ok1, { recursive: true });
        writeFileSync(join(ok1, "SKILL.md"), "---\nname: ok-one\ndescription: ok\n---\n# body\n");

        const ok2 = join(tmpCwd, ".taco", "skills", "ok-two");
        mkdirSync(ok2, { recursive: true });
        writeFileSync(join(ok2, "SKILL.md"), "---\nname: ok-two\ndescription: ok\n---\n# body\n");

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
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(tmpCwd, { recursive: true, force: true });
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
