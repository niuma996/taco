/**
 * Prompt module unit tests.
 *
 * Run with Node's built-in `node:test` runner through tsx:
 *
 *   pnpm --filter @taco-ai/sidecar test:prompts
 *
 * No new dependencies — Node 22 ships `node:test` and `tsx` is already in
 * sidecar's devDependencies.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildPlatformPrompt } from "../../src/prompts/buildPlatformPrompt.ts";
import {
    buildSystemPrompt,
    filterContributorsForTools,
} from "../../src/prompts/buildSystemPrompt.ts";
import { fillPlaceholders } from "../../src/prompts/fillPlaceholders.ts";
import { projectContextForPrompt } from "../../src/prompts/projectContext.ts";
import { toolSummaryForPrompt } from "../../src/prompts/toolSummary.ts";

const stubTool = (name: string) => ({ name });

describe("fillPlaceholders", () => {
    it("replaces known keys", () => {
        const out = fillPlaceholders("tools: {{TOOL_NAMES}}", { TOOL_NAMES: "read, edit" });
        assert.equal(out, "tools: read, edit");
    });

    it("replaces multiple occurrences", () => {
        const out = fillPlaceholders("{{X}} and {{X}}", { X: "same" });
        assert.equal(out, "same and same");
    });

    it("leaves unknown keys untouched", () => {
        const out = fillPlaceholders("keep {{UNKNOWN}}", { KNOWN: "x" });
        assert.equal(out, "keep {{UNKNOWN}}");
    });

    it("handles empty placeholder set", () => {
        const out = fillPlaceholders("no placeholders", {});
        assert.equal(out, "no placeholders");
    });
});

describe("buildPlatformPrompt", () => {
    it("selects Windows for win32", () => {
        const out = buildPlatformPrompt("win32");
        assert.ok(out.includes("PowerShell"));
        assert.ok(out.includes("Windows"));
    });

    it("selects macOS for darwin", () => {
        const out = buildPlatformPrompt("darwin");
        assert.ok(out.includes("macOS"));
        // Interactive default zsh is mentioned in PLATFORM_MACOS; the
        // SHELL_PLATFORM_MACOS block (which names bash) only fires when the
        // `shell` tool is in the tool set — and is covered separately below.
        assert.ok(out.includes("zsh"));
        assert.ok(!out.includes("Shell tool"));
    });

    it("selects Linux for linux", () => {
        const out = buildPlatformPrompt("linux");
        assert.ok(out.includes("Linux"));
        assert.ok(out.includes("apt"));
        assert.ok(!out.includes("Shell tool"));
    });

    it("falls back to generic for unknown platforms", () => {
        const out = buildPlatformPrompt("freebsd");
        assert.ok(out.includes("unknown"));
        assert.ok(out.includes("Sense the environment"));
        assert.ok(!out.includes("Shell tool"));
    });

    it("appends shell block on macOS when shell tool is available", () => {
        const out = buildPlatformPrompt("darwin", ["read", "shell"]);
        assert.ok(out.includes("Shell tool (macOS)"));
    });

    it("appends powershell block on Windows when shell tool is available", () => {
        const out = buildPlatformPrompt("win32", ["shell"]);
        assert.ok(out.includes("Shell tool (Windows)"));
        assert.ok(out.includes("powershell.exe"));
    });

    it("omits shell block when shell tool is absent", () => {
        const out = buildPlatformPrompt("darwin", ["read", "grep"]);
        assert.ok(!out.includes("Shell tool"));
        assert.ok(!out.includes("**Shell tool"));
    });

    it("does not treat legacy bash/powershell names as the shell tool", () => {
        // Agent whitelists may still say "bash" / "powershell"; only the
        // literal "shell" name should trigger the SHELL_PLATFORM_* block.
        const fromBash = buildPlatformPrompt("linux", ["bash"]);
        assert.ok(!fromBash.includes("Shell tool"));
        const fromPowerShell = buildPlatformPrompt("win32", ["powershell"]);
        assert.ok(!fromPowerShell.includes("Shell tool"));
    });
});

describe("buildSystemPrompt", () => {
    it("injects tool names into the core template", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read"), stubTool("edit")] });
        assert.ok(out.includes("read, edit"));
        assert.ok(out.includes("You are TACO"));
    });

    it("defaults to main role with depth 0", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.match(out, /<session_role>/);
        assert.match(out, /You are running as a main session\./);
        assert.ok(!out.includes("Depth:"), "main session must not show a depth line");
        assert.match(out, /- main: you are the user's primary assistant/);
        assert.match(out, /- subagent: you are a delegated sub-agent/);
    });

    it("renders subagent role with depth", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            sessionKind: { role: "subagent", depth: 2 },
        });
        assert.match(out, /You are running as a subagent session\. Depth: 2\./);
        assert.match(out, /do not recursively spawn further sub-agents/);
        assert.match(out, /If your task requires a tool that is not available in this session/);
        assert.match(out, /instruct the parent agent to complete that step/);
    });

    it("renders the platform section including the shell block when shell is available", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read"), stubTool("shell")],
            platform: "darwin",
        });
        assert.ok(out.includes("macOS"));
        assert.ok(out.includes("Shell tool (macOS)"));
    });

    it("omits the shell block when no shell tool is in the set", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            platform: "darwin",
        });
        assert.ok(out.includes("macOS"));
        assert.ok(!out.includes("Shell tool"));
    });

    it("includes the data-protection section instructing the model not to reveal secrets", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(out.includes("<data_protection>"));
        assert.ok(out.includes("Never reveal a secret's value"));
        assert.ok(out.includes("[REDACTED:API_KEY]"));
    });

    it("prepends contributor sections", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            contributors: [{ prepend: "PREFIX" }],
        });
        assert.ok(out.startsWith("PREFIX"));
    });

    it("appends contributor sections", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            contributors: [{ append: "SUFFIX" }],
        });
        assert.ok(out.endsWith("SUFFIX"));
    });

    it("fills MODEL_IDENTITY with the supplied identity string", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            modelIdentity: "anthropic/claude-opus-4",
        });
        assert.match(out, /<model_identity>anthropic\/claude-opus-4<\/model_identity>/);
    });

    it("falls back to 'unknown' when no model identity is supplied", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.match(out, /<model_identity>unknown<\/model_identity>/);
    });

    it("includes the citation discipline section ahead of tone/workflow", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        const citationIdx = out.indexOf("<citation_discipline>");
        const toneIdx = out.indexOf("<tone_and_style>");
        assert.ok(citationIdx > -1, "section must be present");
        assert.ok(toneIdx > -1, "section must be present");
        assert.ok(
            citationIdx < toneIdx,
            "citation discipline must precede tone so the model reads it first",
        );
    });

    it("does NOT advertise an escalation contract — no sidecar handler exists yet", () => {
        // Regression for P1-3: we once shipped a `<escalation_contract>`
        // section describing a `<<<NEEDS_PRO>>>` marker, but the sidecar
        // has no runtime handler that surfaces it. A dead instruction trains
        // the model to expect a rotation that does not happen.
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(
            !out.includes("<<<NEEDS_PRO>>>"),
            "must not reference a marker the sidecar cannot consume",
        );
        assert.ok(
            !out.includes("<escalation_contract>"),
            "must not publish a contract without a runtime handler",
        );
    });

    it("injects a project context block when supplied", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            projectContext: "<project_context>hello</project_context>",
        });
        assert.ok(out.includes("<project_context>hello</project_context>"));
    });

    it("omits the project context block when not supplied", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(!out.includes("<project_context>"));
    });

    it("treats an empty project context string as 'no section'", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            projectContext: "",
        });
        assert.ok(!out.includes("<project_context>"));
    });

    it("uses the default path_semantics block (with absolute-path example) for local channels", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(out.includes("/Users/me/project/src/foo.ts"), "default keeps absolute example");
    });

    it("uses the hidden path_semantics block (no absolute example) when hideWorkspacePath", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            hideWorkspacePath: true,
        });
        assert.ok(!out.includes("/Users/me/project/src/foo.ts"), "hidden drops absolute example");
        assert.ok(
            out.includes("Never echo a full filesystem path back to the user"),
            "hidden forbids echoing paths",
        );
    });

    it("channel_safety also constrains quoting tool results", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            hideWorkspacePath: true,
        });
        assert.match(out, /quoting tool results too/);
        assert.match(out, /strip the path down to its relative form or omit it/);
    });
});

describe("filterContributorsForTools", () => {
    it("keeps contributors without a requires tag regardless of toolset", () => {
        const out = filterContributorsForTools([{ append: "plain" }], new Set());
        assert.deepEqual(
            out.map((c) => c.append),
            ["plain"],
        );
    });

    it("drops a skills-tagged contributor when the child has no skill tool", () => {
        // Regression for subagent rebuild: a read-only explorer must not see
        // `<available_skills>` because it cannot invoke the skill tool.
        const out = filterContributorsForTools(
            [{ append: "<available_skills>...</available_skills>", requires: ["skills"] }],
            new Set(["read", "grep", "glob"]),
        );
        assert.deepEqual(out, []);
    });

    it("keeps a skills-tagged contributor when the child has the skill tool", () => {
        const out = filterContributorsForTools(
            [{ append: "skills block", requires: ["skills"] }],
            new Set(["read", "skill"]),
        );
        assert.equal(out.length, 1);
        assert.equal(out[0].append, "skills block");
    });
});

describe("toolSummaryForPrompt", () => {
    it("returns an empty string for an empty toolset", () => {
        assert.equal(toolSummaryForPrompt([]), "");
    });

    it("reads `taco.promptSummary` and `taco.mutates` from each tool's inline metadata", () => {
        const out = toolSummaryForPrompt([
            { name: "read", taco: { promptSummary: "Read a file.", mutates: false } },
            { name: "write", taco: { promptSummary: "Write a file.", mutates: true } },
        ]);
        assert.match(out, /- read \[read-only\] — Read a file\./);
        assert.match(out, /- write \[mutates\] — Write a file\./);
    });

    it("falls back to 'see schema description' when a tool has no `taco` metadata", () => {
        const out = toolSummaryForPrompt([{ name: "novel-tool" }]);
        assert.match(out, /- novel-tool \[mutates\] — See the tool's schema/);
    });

    it("defaults `mutates` to true when omitted (conservative failure mode)", () => {
        const out = toolSummaryForPrompt([
            { name: "ambiguous", taco: { promptSummary: "Unmarked tool." } },
        ]);
        assert.match(out, /- ambiguous \[mutates\]/);
    });

    it("falls back per-line when only some tools have metadata", () => {
        const out = toolSummaryForPrompt([
            { name: "read", taco: { promptSummary: "Read a file.", mutates: false } },
            { name: "novel-tool" },
        ]);
        assert.match(out, /- read \[read-only\] — Read a file\./);
        assert.match(out, /- novel-tool \[mutates\] — See the tool's schema/);
    });
});

describe("projectContextForPrompt", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-pctx-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("returns '' when .gitignore is missing", () => {
        assert.equal(projectContextForPrompt({ cwd: dir }), "");
    });

    it("returns '' when .gitignore is empty", () => {
        writeFileSync(join(dir, ".gitignore"), "");
        assert.equal(projectContextForPrompt({ cwd: dir }), "");
    });

    it("returns '' when .gitignore contains only whitespace / comments", () => {
        writeFileSync(join(dir, ".gitignore"), "\n\n# comment\n   \n");
        // Whitespace-only lines still count as content; we keep the
        // documented behavior: any non-empty file produces a block, even if
        // its only lines are comments. Models that see "no entries" still
        // understand the workspace has a denylist file.
        const out = projectContextForPrompt({ cwd: dir });
        assert.ok(out.includes("<project_context>"));
        assert.ok(out.includes("truncated by lines"));
    });

    it("renders the working directory and a code-fenced block", () => {
        writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
        const out = projectContextForPrompt({ cwd: dir });
        assert.match(out, /Working directory:\s+.+/);
        assert.match(out, /```\nnode_modules\/\n```/);
        assert.match(out, /Avoid grep \/ glob \/ read on these paths/);
    });

    it("includes a channel_safety paragraph when hideWorkspacePath is true", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read")],
            hideWorkspacePath: true,
        });
        assert.match(out, /<channel_safety>/);
        assert.match(
            out,
            /Do not reveal the current working directory, absolute filesystem paths, or project structure/,
        );
    });

    it("omits the channel_safety paragraph for normal workspaces", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(!out.includes("<channel_safety>"));
    });

    it("truncates by lines so the budget is never exceeded", () => {
        // 50 lines, each 100 chars. With maxChars=300, only a few fit.
        const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-` + "x".repeat(90));
        writeFileSync(join(dir, ".gitignore"), lines.join("\n"));
        const out = projectContextForPrompt({ cwd: dir, maxChars: 300 });
        // The truncated block itself is bounded by maxChars; the wrapper
        // adds ~300 chars on top, so the total is bounded but not equal.
        // Pin the contract: the .gitignore fragment inside the fence is
        // ≤ maxChars.
        const fenceMatch = out.match(/```\n([\s\S]*?)\n```/);
        assert.ok(fenceMatch, "code fence must surround the truncated content");
        const fragment = fenceMatch[1] ?? "";
        assert.ok(
            fragment.length <= 300,
            `gitignore fragment must respect maxChars, got ${fragment.length}`,
        );
        // At least the first line is present, last line is dropped.
        assert.ok(fragment.startsWith("line-0-"));
        assert.ok(!fragment.includes("line-49-"));
    });

    it("omits the working directory line when hideCwd is true", () => {
        writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
        const out = projectContextForPrompt({ cwd: dir, hideCwd: true });
        assert.ok(!out.includes("Working directory"), "must not expose cwd line");
        assert.ok(!out.includes(dir), "must not contain the absolute cwd");
        assert.match(out, /```\nnode_modules\/\n```/);
    });
});
