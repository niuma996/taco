// Builtin skill contract tests: deep-review, taco-configure, fan-out agents, frontmatter parsing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import type { Skill } from "../../src/runtime/pi/types.ts";
import { READ_ONLY_SHELL_AGENT_TYPES } from "../../src/runtime/subagent/childAttach.ts";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";

const DR_HERE = dirname(fileURLToPath(import.meta.url));
const DR_SKILL_PATH = join(
    DR_HERE,
    "..",
    "..",
    "src",
    "skills",
    "builtin",
    "deep-review",
    "SKILL.md",
);
const BUILTIN_AGENT_DIR = join(DR_HERE, "..", "..", "src", "agents", "builtin");

function drBody(): string {
    return readFileSync(DR_SKILL_PATH, "utf-8");
}

describe("deep-review builtin skill", () => {
    it("frontmatter declares name + description + runAs:inline + inlineOnly:true", () => {
        const fm = parseYamlFrontmatter(drBody());
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
            filePath: DR_SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(DR_SKILL_PATH);
        assert.equal(fm.runAs, "inline");
        assert.equal(fm.inlineOnly, true);
    });

    it("body teaches a bounded parallel reviewer fan-out", () => {
        const md = drBody();
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
        const md = drBody().toLowerCase();
        assert.ok(md.includes("dedup"), "must instruct deduplication across lenses");
        assert.ok(
            md.includes("corroborat") || md.includes("confidence"),
            "must explain how agreement between lenses affects confidence",
        );
    });

    it("body specifies the shape of the single synthesized deliverable", () => {
        // Without this the model fans out correctly and then dumps five raw
        // reports, which is the failure mode the whole skill exists to avoid.
        const md = drBody();
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
        const md = drBody();
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
        const toolSrc = readFileSync(
            join(DR_HERE, "..", "..", "src", "tools", "agent.ts"),
            "utf-8",
        );
        assert.ok(toolSrc.includes("context: Type.Optional"), "agent tool must expose `context`");
        assert.ok(toolSrc.includes('Type.Literal("fork")'), "`fork` must be an accepted value");
        assert.ok(
            toolSrc.includes('Type.Literal("independent")'),
            "`independent` must be an accepted value",
        );
        const md = drBody();
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
            drBody().includes("subagent_type=verification"),
            "body must show the verification pairing",
        );
    });
});

const TC_HERE = dirname(fileURLToPath(import.meta.url));
const TC_SKILL_PATH = join(
    TC_HERE,
    "..",
    "..",
    "src",
    "skills",
    "builtin",
    "taco-configure",
    "SKILL.md",
);

function tcBody(): string {
    return readFileSync(TC_SKILL_PATH, "utf-8");
}

describe("taco-configure builtin skill", () => {
    it("frontmatter declares name + description, no runAs (default inline)", () => {
        const fm = parseYamlFrontmatter(tcBody());
        assert.equal(fm.name, "taco-configure");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be a non-empty string so the skill surfaces in the prompt",
        );
        assert.ok(
            fm.description.toLowerCase().startsWith("use when"),
            "description must lead with the trigger phrase so the model knows when to reach for it",
        );
        // Length stays under pi's 1024-char ceiling so the loader won't flag it.
        assert.ok(fm.description.length <= 1024, "description must fit pi's ceiling");
        // Default runAs is inline; assert nothing declares otherwise. The
        // umbrella writes files and walks the user through choices — those
        // belong in the calling session, not a subagent.
        assert.equal(
            fm.runAs,
            undefined,
            "taco-configure should not override runAs; default inline is correct",
        );
        assert.equal(
            fm.inlineOnly,
            undefined,
            "taco-configure should not be inlineOnly — a subagent can also write skill/agent files",
        );
    });

    it("directory name matches the frontmatter name (pi loads SKILL.md under a directory named after the skill)", () => {
        const fm = parseYamlFrontmatter(tcBody());
        const parentDir = TC_SKILL_PATH.split("/").slice(-2, -1)[0];
        assert.equal(parentDir, fm.name, "parent directory must equal frontmatter name");
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path and uses no taco-private keys", () => {
        const skill: Skill = {
            name: "taco-configure",
            description: "stub",
            filePath: TC_SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(TC_SKILL_PATH);
        // If taco-private keys get added here, this test will surface them —
        // the umbrella should use defaults, not override them.
        assert.equal(fm.runAs, undefined);
        assert.equal(fm.inlineOnly, undefined);
        assert.equal(fm.allowedTools, undefined);
        assert.equal(fm.model, undefined);
    });

    it("stays within a workable size band — substantive but not superpowers-verbose", () => {
        // Lower bound guards against the body being trimmed back into a
        // checklist; upper bound guards against it growing into a treatise.
        const words = tcBody().split(/\s+/).filter(Boolean).length;
        assert.ok(words > 400, `expected >400 words (substantive), got ${words}`);
        assert.ok(words < 1100, `expected <1100 words (still lean), got ${words}`);
    });
});

const FO_HERE = dirname(fileURLToPath(import.meta.url));
const FO_SKILL_PATH = join(
    FO_HERE,
    "..",
    "..",
    "src",
    "skills",
    "builtin",
    "fan-out-agents",
    "SKILL.md",
);

describe("fan-out-agents builtin skill", () => {
    it("frontmatter declares name + description + runAs:inline + inlineOnly:true", () => {
        const md = readFileSync(FO_SKILL_PATH, "utf-8");
        const fm = parseYamlFrontmatter(md);
        assert.equal(fm.name, "fan-out-agents");
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
            name: "fan-out-agents",
            description: "stub",
            filePath: FO_SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(FO_SKILL_PATH);
        assert.equal(fm.runAs, "inline");
        assert.equal(fm.inlineOnly, true);
    });

    it("body teaches parallel fan-out, not subagent dispatch from inside a subagent", () => {
        const md = readFileSync(FO_SKILL_PATH, "utf-8");
        // Spot-check the body covers the contract the frontmatter implies.
        assert.ok(md.includes("`agent`"), "body must reference the `agent` tool");
        assert.ok(
            md.toLowerCase().includes("parallel") || md.includes("Promise.all"),
            "body must explain parallel execution",
        );
        assert.ok(
            md.includes("inline-only") || md.includes("inline only"),
            "body must restate the inline-only constraint for readers who skip the frontmatter",
        );
    });
});

describe("parseYamlFrontmatter", () => {
    it("returns empty object when no frontmatter block is present", () => {
        assert.deepEqual(parseYamlFrontmatter("just markdown body\n"), {});
    });

    it("parses the block as YAML even when not terminated by a closing fence", () => {
        // gray-matter treats an unterminated `---` block as the full YAML
        // document; documenting that behavior so future changes do not regress
        // it silently.
        assert.deepEqual(parseYamlFrontmatter("---\nfoo: bar\n"), { foo: "bar" });
    });

    it("parses top-level scalar values", () => {
        const out = parseYamlFrontmatter(`---
name: my-skill
model: opus
---`);
        assert.equal(out.name, "my-skill");
        assert.equal(out.model, "opus");
    });

    it("parses inline lists", () => {
        const out = parseYamlFrontmatter(`---
allowedTools: [read, write, bash]
---`);
        assert.deepEqual(out.allowedTools, ["read", "write", "bash"]);
    });

    it("ignores comments and blank lines inside the block", () => {
        const out = parseYamlFrontmatter(`---
# a comment
name: my-skill

model: opus
---`);
        assert.equal(out.name, "my-skill");
        assert.equal(out.model, "opus");
    });

    it("preserves the body content outside the block", () => {
        const out = parseYamlFrontmatter(`---
name: my-skill
---
# Heading

body content here`);
        assert.equal(out.name, "my-skill");
    });

    it("normalizes CRLF line endings", () => {
        const out = parseYamlFrontmatter("---\r\nname: my-skill\r\n---\r\n");
        assert.equal(out.name, "my-skill");
    });
});
