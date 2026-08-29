/**
 * Real-filesystem, real-chokidar coverage for skill hot reload — the first
 * fs-watcher test in this codebase. Kept as a single targeted case rather
 * than a full suite: real fs event timing can be flaky in CI, so this only
 * proves the wiring (watch → debounce → reloadSkillsNow → resources.skills)
 * works end to end; the pure logic (dedup, frontmatter, prompt rebuild) is
 * covered by workspace.skillReload.test.ts and skillFrontmatter tests with
 * stub callbacks instead of a live watcher.
 *
 * Uses a bounded poll (2s budget) rather than a fixed sleep, since the
 * debounce (300ms) plus OS fs-event latency isn't perfectly deterministic.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

async function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs = 50,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!predicate()) {
        throw new Error(`condition not met within ${timeoutMs}ms`);
    }
}

let skillsDir: string;
let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ws-skillwatch-"));
    skillsDir = join(tmpDir, "skills");
    // Pre-create the skill dir BEFORE the watcher starts. Creating a new
    // directory and its SKILL.md in the same synchronous burst lets Chokidar
    // discover the file while scanning the new directory's *initial* entries;
    // with ignoreInitial:true it correctly suppresses that event. This test
    // needs an already-watched directory so the later file write is
    // unambiguously a post-ready `add` event.
    mkdirSync(join(skillsDir, "watched-skill"), { recursive: true });
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("WorkspaceRuntime skill fs watcher (real chokidar)", () => {
    it("picks up a newly-written SKILL.md without an explicit reload call", async () => {
        let scanResult: TacoSkill[] = [];
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [] },
            skillDirs: [skillsDir],
            // Stub scan: real directory scanning (loadSourcedSkills etc.) is
            // SidecarServer's job and is exercised elsewhere (server.skillsDedupe
            // tests). This test only needs to prove the fs event reaches
            // reloadSkillsNow — the callback just needs to return *something*
            // that changed, so resources.skills is verifiable proof the watcher
            // fired.
            reloadSkills: async () => ({ skills: scanResult, diagnostics: [] }),
        });

        try {
            // Chokidar ignores initial entries by design. Without awaiting its
            // `ready` event, a busy parallel test run can create the skill
            // while Chokidar still classifies the directory as initial state,
            // then legitimately emit no post-ready `add` event. The production
            // startup scan already covers files written before readiness; this
            // test is specifically proving a *post-ready* fs change reloads.
            await ws.skillWatcherReady;

            const newSkillDir = join(skillsDir, "watched-skill");
            scanResult = [
                {
                    name: "watched-skill",
                    description: "written after construction",
                    filePath: join(newSkillDir, "SKILL.md"),
                    content: "# watched-skill",
                    source: "user",
                },
            ];
            writeFileSync(join(newSkillDir, "SKILL.md"), "---\nname: watched-skill\n---\nbody");

            await waitFor(
                () => (ws.resources.skills?.length ?? 0) > 0,
                2000,
                // A single fs event triggers a 300ms debounce timer inside
                // WorkspaceRuntime before reloadSkillsNow runs; poll at a
                // strictly finer grain than that so the loop doesn't
                // overshoot the debounce window on the first check.
                40,
            );

            assert.equal(ws.resources.skills?.[0]?.name, "watched-skill");
        } finally {
            await ws.dispose();
        }
    });

    // The watcher's blind spot this guards: when a skill dir's whole parent
    // chain is absent (first-run `<cwd>/.taco/skills`), chokidar watches nothing
    // and the first `mkdir -p` + SKILL.md write produces zero events — a silent
    // hot-reload miss for exactly the create-skill flow. The runtime pre-creates
    // the taco-owned leaf to fix this; this test proves a first-time write under
    // an absent parent chain is picked up. See workspace.ts mkdir note.
    it("picks up a SKILL.md created for the first time under an absent parent chain", async () => {
        // Deliberately NOT pre-created: join(tmpDir, ".taco/skills") with no
        // .taco in between — the chain that defeated the bare watcher.
        const freshSkillsDir = join(tmpDir, ".taco", "skills");
        let scanResult: TacoSkill[] = [];
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
            resources: { skills: [] },
            skillDirs: [freshSkillsDir],
            reloadSkills: async () => ({ skills: scanResult, diagnostics: [] }),
        });

        try {
            await ws.skillWatcherReady;

            const newSkillDir = join(freshSkillsDir, "fresh-skill");
            scanResult = [
                {
                    name: "fresh-skill",
                    description: "created under an absent parent chain",
                    filePath: join(newSkillDir, "SKILL.md"),
                    content: "# fresh-skill",
                    source: "user",
                },
            ];
            // mkdir + write in one burst: the dir now exists (pre-created by the
            // runtime), so this is a post-ready `add` under a watched dir.
            mkdirSync(newSkillDir, { recursive: true });
            writeFileSync(join(newSkillDir, "SKILL.md"), "---\nname: fresh-skill\n---\nbody");

            await waitFor(() => (ws.resources.skills?.length ?? 0) > 0, 2000, 40);
            assert.equal(ws.resources.skills?.[0]?.name, "fresh-skill");
        } finally {
            await ws.dispose();
        }
    });
});
