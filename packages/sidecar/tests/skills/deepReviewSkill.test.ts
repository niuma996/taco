/**
 * deep-review builtin skill — static load test.
 *
 * Two jobs. First, guard the frontmatter contract (`runAs: inline` /
 * `inlineOnly: true`), same as fanOutAgentsSkill.test.ts. Second, guard the
 * factual claims the body makes about the runtime: the skill instructs the
 * model to pass `context` to the `agent` tool, to expect `reviewer` to be
 * read-only, and to reach for `verification` when something must actually run.
 * If any of those move, the skill starts teaching something false — which is
 * worse than the skill being absent, because the model will follow it.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/skills/deepReviewSkill.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-agent-core";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import { READ_ONLY_SHELL_AGENT_TYPES } from "../../src/runtime/agentSpawner.ts";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, "..", "..", "src", "skills", "builtin", "deep-review", "SKILL.md");
const BUILTIN_AGENT_DIR = join(HERE, "..", "..", "src", "agents", "builtin");

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("deep-review builtin skill", () => {
    it("exists on disk at the canonical builtin path", () => {
        assert.ok(body().length > 0, "SKILL.md must not be empty");
    });

    it("frontmatter declares name + description + runAs:inline + inlineOnly:true", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(fm.name, "deep-review");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be a non-empty string so the skill surfaces in the prompt",
        );
        assert.equal(fm.runAs, "inline", "must explicitly declare inline mode");
        assert.equal(
            fm.inlineOnly,
            true,
            "must declare inlineOnly so skillTool can hard-fence subagent invocation",
        );
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path", () => {
        const skill: Skill = {
            name: "deep-review",
            description: "stub",
            filePath: SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(SKILL_PATH);
        assert.equal(fm.runAs, "inline");
        assert.equal(fm.inlineOnly, true);
    });

    it("body teaches a bounded parallel reviewer fan-out", () => {
        const md = body();
        assert.ok(
            md.includes("subagent_type=reviewer"),
            "must show dispatching reviewer subagents",
        );
        assert.ok(/2-5/.test(md), "must state the 2-5 reviewer bound");
        assert.ok(
            md.toLowerCase().includes("same assistant message") ||
                md.toLowerCase().includes("one turn"),
            "must explain single-turn dispatch, which is what makes the batch concurrent",
        );
        assert.ok(
            md.includes("inline-only") || md.includes("Inline only"),
            "must restate the inline-only constraint for readers who skip frontmatter",
        );
    });

    it("body requires synthesis rather than concatenating the reports", () => {
        const md = body().toLowerCase();
        assert.ok(md.includes("dedup"), "must instruct deduplication across lenses");
        assert.ok(
            md.includes("corroborat") || md.includes("confidence"),
            "must explain how agreement between lenses affects confidence",
        );
    });

    it("body specifies the shape of the single synthesized deliverable", () => {
        // Without this the model fans out correctly and then dumps five raw
        // reports, which is the failure mode the whole skill exists to avoid.
        const md = body();
        assert.ok(
            /final message is the review/i.test(md),
            "must state that the synthesized answer replaces the subagent reports",
        );
        assert.ok(/verdict/i.test(md), "must require a headline verdict");
        assert.ok(
            /clean/i.test(md),
            "must require reporting what was checked and found clean, not just complaints",
        );
        assert.ok(
            /coverage gap|gaps/i.test(md),
            "must require surfacing coverage gaps so silence is not read as clean",
        );
    });

    it("body resolves reviewer-vs-verification disagreement in favor of the run", () => {
        const md = body();
        assert.ok(
            /verdict wins/i.test(md),
            "an empirical verification result must outrank a reviewer's static reading",
        );
    });

    // ── claims about the runtime the body depends on ──────────────────────

    it("the `context` param the body tells the model to pass actually exists", () => {
        // The body prescribes `context=fork` / `context=independent` on agent
        // calls. If the tool schema drops that param, the skill is teaching an
        // argument that will be rejected.
        const toolSrc = readFileSync(join(HERE, "..", "..", "src", "tools", "agent.ts"), "utf-8");
        assert.ok(toolSrc.includes("context: Type.Optional"), "agent tool must expose `context`");
        assert.ok(toolSrc.includes('Type.Literal("fork")'), "`fork` must be an accepted value");
        assert.ok(
            toolSrc.includes('Type.Literal("independent")'),
            "`independent` must be an accepted value",
        );
        const md = body();
        assert.ok(md.includes("context=fork"), "body should demonstrate the fork mode");
        assert.ok(md.includes("context=independent"), "body should demonstrate independent mode");
    });

    it("reviewer really is read-only, as the body claims", async () => {
        // The body tells the model not to expect reviewers to run tests,
        // justified by the read-only shell gate. Keep that justification true.
        assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("reviewer"), true);
        const agents = await loadAgents({ builtinDir: BUILTIN_AGENT_DIR, userDirs: [] });
        const reviewer = agents.find((a) => a.agentType === "reviewer");
        assert.ok(reviewer, "the reviewer builtin must exist for this skill to dispatch");
        assert.equal(reviewer.context, "fork", "body states reviewer defaults to fork");
    });

    it("verification is still the writable-shell option the body defers to", async () => {
        // The body routes 'must actually execute' work to verification
        // precisely because it is NOT inside the read-only gate.
        assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("verification"), false);
        const agents = await loadAgents({ builtinDir: BUILTIN_AGENT_DIR, userDirs: [] });
        assert.ok(
            agents.some((a) => a.agentType === "verification"),
            "the verification builtin must exist for the pairing step to work",
        );
        assert.ok(
            body().includes("subagent_type=verification"),
            "body must show the verification pairing",
        );
    });
});
