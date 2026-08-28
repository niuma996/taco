/**
 * Inline-only guard for the Skill tool.
 *
 * Skills frontmattered with `inlineOnly: true` must be rejected when invoked
 * in subagent mode — the harness returns an explicit error in the tool result
 * so the model can correct the call instead of silently running the wrong
 * shape. The fan-out skill is the canonical use case: it teaches the model to
 * dispatch `agent` calls, which a subagent cannot route back to the parent.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";
import type { SkillReinjectorHandle } from "../../src/skills/skillReinjector.ts";
import { createSkillTool } from "../../src/skills/skillTool.ts";

function writeSkill(dir: string, name: string, frontmatter: string, body: string): string {
    const skillDir = join(dir, name);
    const filePath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
    return filePath;
}

function mkSkill(name: string, filePath: string): Skill {
    return { name, description: `${name} desc`, filePath, content: "body" } as Skill;
}

describe("SkillTool inlineOnly guard", () => {
    const PER_CALL = 1;
    let workDir: string;

    it("frontmatter parser exposes inlineOnly as a boolean", () => {
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: inline\ninlineOnly: true",
                "# body",
            );
            const fm = readSkillFrontmatter(fp);
            assert.equal(fm.runAs, "inline");
            assert.equal(fm.inlineOnly, true);
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it("rejects subagent-mode invocation when inlineOnly is true", async () => {
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: subagent\ninlineOnly: true",
                "# body",
            );
            const skill = mkSkill("fan-out", fp);
            preloadSkillFrontmatter([skill]);

            let spawnCalled = false;
            const tool = createSkillTool(() => [skill], {
                parentSessionId: "sess-1",
                getReinjector: () => undefined as unknown as SkillReinjectorHandle,
                spawnSkillSubagent: async () => {
                    spawnCalled = true;
                    return { subSessionId: "", resultText: "", isError: false };
                },
            });

            const res = await tool.execute("tc-1", { skill: "fan-out" }, undefined);

            assert.equal(
                spawnCalled,
                false,
                "spawnSkillSubagent must NOT be called for an inlineOnly skill in subagent mode",
            );
            const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.ok(text.includes("inline-only"), "tool result must explain inline-only");
            assert.ok(
                text.includes("fan-out"),
                "tool result must name the skill so the model can correct the call",
            );
            assert.deepEqual(res.details, {
                skillName: "fan-out",
                found: true,
                runAs: "subagent",
            });
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it("still rejects subagent-mode invocation even when spawnSkillSubagent is absent", async () => {
        // Belt-and-braces: the inlineOnly guard fires before the
        // `spawnSkillSubagent` availability check, so missing the spawner does
        // not change the error shape.
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: subagent\ninlineOnly: true",
                "# body",
            );
            const skill = mkSkill("fan-out", fp);
            preloadSkillFrontmatter([skill]);

            const tool = createSkillTool(() => [skill], {
                parentSessionId: "sess-1",
                getReinjector: () => undefined as unknown as SkillReinjectorHandle,
                // spawnSkillSubagent omitted on purpose
            });

            const res = await tool.execute("tc-1", { skill: "fan-out" }, undefined);
            const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.ok(text.includes("inline-only"));
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it("allows inline-mode invocation when inlineOnly is true", async () => {
        // The guard only fires when runAs === "subagent". With runAs === "inline"
        // (the default), the skill proceeds through the normal inline reinject
        // path — that is the whole point of `inlineOnly: true`.
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: inline\ninlineOnly: true",
                "# body",
            );
            const skill = mkSkill("fan-out", fp);
            preloadSkillFrontmatter([skill]);

            const enqueued: unknown[] = [];
            const handle: SkillReinjectorHandle = {
                markInvoked: () => undefined,
                enqueueInlineInjection: (m) => enqueued.push(m),
            };
            const tool = createSkillTool(() => [skill], {
                parentSessionId: "sess-1",
                getReinjector: () => handle,
            });

            const res = await tool.execute("tc-1", { skill: "fan-out" }, undefined);
            const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.ok(text.includes("activated"), "inline path should report activation");
            assert.equal(enqueued.length, 1, "skill body must be enqueued for inline injection");
            assert.deepEqual(res.details, {
                skillName: "fan-out",
                found: true,
                runAs: "inline",
            });
            // PER_CALL is a no-op reference to silence unused-binding linters in
            // some configs.
            void PER_CALL;
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });
});
