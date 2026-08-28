/**
 * WorkspaceRuntime.reloadSkillsNow — unit-level coverage using a stub
 * `reloadSkills` callback (no real filesystem/chokidar involved; that's
 * covered separately by workspace.skillReloadWatcher.test.ts).
 *
 * Verifies the three things a hot reload is supposed to update:
 *  - `resources.skills` (skills.list RPC reads this)
 *  - `systemPrompt` (the baked <available_skills> section used by the next attach)
 *  - the live skill list SessionRegistry.getListingTools()'s skill tool resolves
 *
 * Also verifies the documented limitation: reload with no `reloadSkills`
 * callback configured (the constructor-test default) is a safe no-op, not a
 * throw — matters because `dispose()` and other paths call into a
 * WorkspaceRuntime that many existing tests construct without hot-reload
 * wiring at all.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SkillDiagnosticEntry } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

function mkSkill(name: string): TacoSkill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/tmp/${name}/SKILL.md`,
        content: `# ${name}`,
        source: "user",
    };
}

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ws-skillreload-"));
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("WorkspaceRuntime.reloadSkillsNow", () => {
    it("is a no-op when no reloadSkills callback was configured", async () => {
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [mkSkill("alpha")] },
        });
        const promptBefore = ws.systemPrompt;
        await ws.reloadSkillsNow();
        assert.equal(
            ws.systemPrompt,
            promptBefore,
            "prompt must not change with no callback wired",
        );
        assert.equal(ws.resources.skills?.length, 1);
        await ws.dispose();
    });

    it("updates resources.skills, systemPrompt, and live skill-tool lookup", async () => {
        let scanCount = 0;
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [mkSkill("alpha")] },
            skillDirs: [tmpDir],
            reloadSkills: async () => {
                scanCount++;
                return { skills: [mkSkill("beta")], diagnostics: [] };
            },
        });

        assert.ok(!ws.systemPrompt.includes("beta"), "beta must not be in the prompt yet");

        await ws.reloadSkillsNow();

        assert.equal(scanCount, 1);
        assert.equal(ws.resources.skills?.length, 1);
        assert.equal(ws.resources.skills?.[0]?.name, "beta");
        // SessionRegistry separately supplies `resources` to each new
        // AttachedSession's AgentHarness. This equality is the regression
        // guard for the bug where reload only replaced WorkspaceRuntime's
        // object, leaving newly-attached harnesses on the pre-reload list.
        assert.equal(ws.sessionRegistry.resources.skills?.[0]?.name, "beta");
        assert.notEqual(
            ws.sessionRegistry.resources,
            ws.resources,
            "each layer owns its resource object but both must carry the same skills",
        );
        assert.ok(
            ws.systemPrompt.includes("beta"),
            "expected the rebuilt system prompt to mention the new skill",
        );
        assert.ok(
            !ws.systemPrompt.includes("alpha desc"),
            "expected the stale skill's description to be gone from the rebuilt prompt",
        );

        // Live lookup: SessionRegistry.updateSkills should have been called
        // too, so a freshly-built skill tool resolves "beta" and not "alpha".
        const listing = ws.sessionRegistry.getListingTools();
        const skillTool = listing.find((t) => t.name === "skill") as
            | {
                  execute: (
                      id: string,
                      params: { skill: string },
                      signal?: AbortSignal,
                  ) => Promise<{ details?: { found: boolean } }>;
              }
            | undefined;
        assert.ok(skillTool, "expected a skill tool in getListingTools()");
        const found = await skillTool.execute("tc-1", { skill: "beta" });
        assert.equal(found.details?.found, true);
        const stale = await skillTool.execute("tc-2", { skill: "alpha" });
        assert.equal(stale.details?.found, false);

        await ws.dispose();
    });

    it("collapses concurrent reload calls into one scan (SingleFlight)", async () => {
        let scanCount = 0;
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [] },
            skillDirs: [tmpDir],
            reloadSkills: async () => {
                scanCount++;
                await new Promise((r) => setTimeout(r, 20));
                return { skills: [mkSkill("gamma")], diagnostics: [] };
            },
        });

        await Promise.all([ws.reloadSkillsNow(), ws.reloadSkillsNow(), ws.reloadSkillsNow()]);

        assert.equal(scanCount, 1, "three concurrent calls should share one in-flight scan");
        assert.equal(ws.resources.skills?.[0]?.name, "gamma");

        await ws.dispose();
    });

    it("replaces the previous diagnostics set on reload, rather than merging", async () => {
        // Regression guard: a fix on disk must silence its own warning.
        // Without replacement semantics a SKILL.md the user just repaired would
        // keep showing up as broken, which is exactly the silent-doesn't-apply
        // behavior hot reload was supposed to fix.
        const stale: SkillDiagnosticEntry = {
            code: "parse_failed",
            message: "old broken state",
            path: "/stale/SKILL.md",
        };
        const next: SkillDiagnosticEntry = {
            code: "duplicate_name",
            message: "fresh shadowing",
            path: "/fresh/SKILL.md",
        };
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [] },
            skillDiagnostics: [stale],
            skillDirs: [tmpDir],
            reloadSkills: async () => ({ skills: [], diagnostics: [next] }),
        });

        assert.deepEqual(ws.skillDiagnostics, [stale], "constructor seed must round-trip");
        await ws.reloadSkillsNow();
        assert.deepEqual(ws.skillDiagnostics, [next], "reload must replace, not append");
        assert.ok(
            !ws.skillDiagnostics.includes(stale),
            "a fixed file must stop being reported after the reload that fixed it",
        );

        await ws.dispose();
    });
});
