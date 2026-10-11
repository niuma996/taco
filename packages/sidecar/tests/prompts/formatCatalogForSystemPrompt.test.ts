/**
 * System-prompt catalog blocks (deferred tools / agent types / skills).
 *
 *   pnpm --filter @taco-ai/sidecar test -- tests/prompts/formatCatalogForSystemPrompt.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    formatAgentsForSystemPrompt,
    formatDeferredToolsForSystemPrompt,
} from "../../src/prompts/formatCatalogForSystemPrompt.ts";
import { formatSkillsForSystemPrompt } from "../../src/prompts/formatSkillsForSystemPrompt.ts";
import type { Skill } from "../../src/runtime/pi/types.ts";

describe("formatDeferredToolsForSystemPrompt", () => {
    it("returns empty when there are no deferred tools", () => {
        assert.equal(formatDeferredToolsForSystemPrompt([]), "");
    });

    it("lists name and summary", () => {
        const out = formatDeferredToolsForSystemPrompt([
            { name: "git-status", summary: "show git status" },
        ]);
        assert.match(out, /<deferred_tools>/);
        assert.match(out, /<name>git-status<\/name>/);
        assert.match(out, /<summary>show git status<\/summary>/);
    });
});

describe("formatAgentsForSystemPrompt", () => {
    it("returns empty when there are no types", () => {
        assert.equal(formatAgentsForSystemPrompt([]), "");
    });

    it("prefers whenToUse over description and flags fork defaults", () => {
        const out = formatAgentsForSystemPrompt([
            {
                agentType: "reviewer",
                description: "short blurb",
                whenToUse: "pick me when reviewing",
                context: "fork",
            },
            { agentType: "explorer", description: "search", context: "independent" },
        ]);
        assert.match(out, /<name>reviewer<\/name>/);
        assert.match(out, /pick me when reviewing/);
        assert.ok(!out.includes("short blurb"));
        assert.match(out, /forked context/);
        const explorerBlock = out.slice(out.indexOf("<name>explorer</name>"));
        assert.ok(!explorerBlock.includes("forked context"));
    });

    it("still lists a type with no description", () => {
        const out = formatAgentsForSystemPrompt([{ agentType: "bare" }]);
        assert.match(out, /<name>bare<\/name>/);
    });

    it("collapses multi-line frontmatter into a single when_to_use line", () => {
        const out = formatAgentsForSystemPrompt([
            { agentType: "wrapped", whenToUse: "line one\n  line two\n\nline three" },
        ]);
        assert.match(out, /<when_to_use>line one line two line three<\/when_to_use>/);
        assert.ok(!out.includes("line one\n"));
    });
});

describe("formatSkillsForSystemPrompt", () => {
    const skill = {
        name: "deploy",
        description: "Ship the app",
        filePath: "/Users/someone/.taco/skills/deploy/SKILL.md",
        disableModelInvocation: false,
    } as unknown as Skill;

    it("names the tool as `skill`, not `<skill>`", () => {
        const out = formatSkillsForSystemPrompt([skill]);
        assert.match(out, /Use the `skill` tool/);
        assert.ok(!out.includes("<skill> tool"));
    });

    it("includes the location and path-resolution guidance by default", () => {
        const out = formatSkillsForSystemPrompt([skill]);
        assert.match(
            out,
            /<location>\/Users\/someone\/\.taco\/skills\/deploy\/SKILL\.md<\/location>/,
        );
        assert.match(out, /resolve it against the skill directory/);
    });

    // Regression: IM sessions rendered the absolute host path even though the
    // default IM policy strips every file-reading tool, so the path was both
    // useless to the model and visible to the third party on the channel.
    it("omits every absolute path when includeLocation is false", () => {
        const out = formatSkillsForSystemPrompt([skill], { includeLocation: false });
        assert.ok(!out.includes("<location>"));
        assert.ok(!out.includes("/Users/someone"));
        assert.ok(!out.includes("resolve it against the skill directory"));
        assert.match(out, /<name>deploy<\/name>/);
        assert.match(out, /<description>Ship the app<\/description>/);
    });
});
