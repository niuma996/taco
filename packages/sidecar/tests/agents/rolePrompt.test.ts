/**
 * Agent profile assembly — the profile body must reach the child's system
 * prompt. Exercises the same buildSystemPrompt call shape AgentSpawner uses;
 * a full spawn needs a live provider.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseAgentMarkdown } from "../../src/agents/loadAgents.ts";
import {
    buildSystemPrompt,
    type SystemPromptContributor,
} from "../../src/prompts/buildSystemPrompt.ts";

const TOOLS = [{ name: "read" }, { name: "grep" }, { name: "glob" }];

/** Mirrors AgentSpawner.executeSubagentSession's contributor assembly. */
function childPrompt(role: string | undefined, base: SystemPromptContributor[] = []): string {
    const trimmed = role?.trim();
    return buildSystemPrompt({
        tools: TOOLS,
        contributors: trimmed ? [...base, { append: trimmed }] : base,
    });
}

describe("agent profile role prompt", () => {
    it("includes the profile body in the child system prompt", () => {
        const out = childPrompt("You are a read-only explorer. Report file:line only.");
        assert.match(out, /read-only explorer/);
        assert.match(out, /Report file:line only/);
    });

    it("places the profile last so it overrides generic workflow guidance", () => {
        const role = "STOP after answering the question.";
        const out = childPrompt(role);
        assert.ok(out.trimEnd().endsWith(role), "profile body should be the final section");
    });

    it("preserves workspace contributors alongside the profile", () => {
        const out = childPrompt("ROLE_BODY", [{ append: "WORKSPACE_RULES" }]);
        assert.match(out, /WORKSPACE_RULES/);
        assert.match(out, /ROLE_BODY/);
        assert.ok(
            out.indexOf("WORKSPACE_RULES") < out.indexOf("ROLE_BODY"),
            "profile must come after workspace contributors",
        );
    });

    it("omits the section entirely for a blank or missing profile", () => {
        const base = buildSystemPrompt({ tools: TOOLS });
        assert.equal(childPrompt(undefined), base);
        assert.equal(childPrompt("   \n  "), base);
    });

    it("carries a real builtin profile through parse into the prompt", () => {
        const md = [
            "---",
            "name: explorer",
            "description: read-only search",
            "tools: [read, grep, glob]",
            "maxTurns: 30",
            "---",
            "",
            "You are a read-only file search specialist.",
        ].join("\n");
        const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
        assert.ok(def);
        assert.equal(def?.maxTurns, 30);
        assert.match(childPrompt(def?.systemPrompt), /read-only file search specialist/);
    });
});
