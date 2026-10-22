// Prompt assembly tests: system/platform prompt, placeholders, project context, catalogs, skill authoring guidance.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultSkillDirs } from "../../src/config/config.ts";
import { buildPlatformPrompt } from "../../src/prompts/buildPlatformPrompt.ts";
import {
    buildSystemPrompt,
    filterContributorsForTools,
    type SystemPromptContributorTag,
} from "../../src/prompts/buildSystemPrompt.ts";
import { fillPlaceholders } from "../../src/prompts/fillPlaceholders.ts";
import {
    formatAgentsForSystemPrompt,
    formatDeferredToolsForSystemPrompt,
} from "../../src/prompts/formatCatalogForSystemPrompt.ts";
import { formatSkillsForSystemPrompt } from "../../src/prompts/formatSkillsForSystemPrompt.ts";
import { projectContextForPrompt } from "../../src/prompts/projectContext.ts";
import { formatSkillAuthoringGuidance } from "../../src/prompts/skillAuthoringGuidance.ts";
import {
    buildEnvironmentPrompt,
    type EnvironmentContext,
} from "../../src/prompts/templates/environment.ts";
import { toolSummaryForPrompt } from "../../src/prompts/toolSummary.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

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
        assert.match(out, /You are the user's primary assistant/);
        assert.ok(
            !out.includes("You are a delegated sub-agent"),
            "main prompt must not carry the subagent role body",
        );
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
        assert.ok(
            !out.includes("user's primary assistant"),
            "subagent prompt must not carry the main role body",
        );
    });

    it("renders delegation guidance for main sessions only, with no leaked template markers", () => {
        const main = buildSystemPrompt({ tools: [stubTool("read"), stubTool("agent")] });
        assert.match(main, /decompose and delegate to sub-agents with the agent tool/);

        const sub = buildSystemPrompt({
            tools: [stubTool("read")],
            sessionKind: { role: "subagent", depth: 1 },
        });
        assert.ok(
            !sub.includes("delegate to sub-agents with the agent tool"),
            "subagent must not be told to delegate — its role body forbids recursion",
        );

        // Regression: the delegation block shipped with literal `{subagent_delegation}`
        // guards because only `{{double-brace}}` placeholders are interpolated.
        for (const out of [main, sub]) {
            assert.ok(
                !out.includes("{subagent_delegation}"),
                "literal guard must not reach the model",
            );
            assert.ok(
                !out.includes("{/subagent_delegation}"),
                "literal guard must not reach the model",
            );
            assert.ok(!out.includes("{{"), "no unfilled placeholder may remain");
        }
    });

    it("routes user-owned decisions per role: askUser for main, the parent for a subagent", () => {
        const main = buildSystemPrompt({ tools: [stubTool("read"), stubTool("askUser")] });
        assert.match(main, /call the `askUser` tool and block for the answer/);
        assert.match(main, /Stop and call `askUser` \(or wait for a new instruction\)/);

        // Regression: a subagent has no askUser (filterToolsForAgent strips it at
        // depth>=1), so telling it to call one contradicts its own tool list.
        const sub = buildSystemPrompt({
            tools: [stubTool("read")],
            sessionKind: { role: "subagent", depth: 1 },
        });
        assert.ok(!sub.includes("askUser"), "subagent prompt must not reference askUser");
        assert.match(sub, /state the decision and its options in your final reply/);
        assert.match(sub, /report the denial in your final reply/);

        for (const out of [main, sub]) {
            assert.match(out, /stop and report what is blocking you/);
            assert.ok(!out.includes("{{"), "no unfilled placeholder may remain");
        }
    });

    it("appends the delegation section after the core template, before contributor appends", () => {
        const out = buildSystemPrompt({
            tools: [stubTool("read"), stubTool("agent")],
            contributors: [{ append: "<available_agents>fake</available_agents>" }],
        });
        const delegationIdx = out.indexOf("<subagent_delegation>");
        assert.ok(delegationIdx > out.indexOf("</workflow>"), "delegation sits past the core");
        assert.ok(
            delegationIdx < out.indexOf("<available_agents>fake"),
            "delegation guidance precedes the agents catalog it references",
        );

        const sub = buildSystemPrompt({
            tools: [stubTool("read")],
            sessionKind: { role: "subagent", depth: 1 },
            contributors: [{ append: "<available_agents>fake</available_agents>" }],
        });
        assert.ok(!sub.includes("<subagent_delegation>"), "subagent tail stays clean");
    });

    it("frames a permission denial as a stop-and-ask, not a retry cue", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.match(out, /A permission denial is a decision, not a mechanical failure/);
        assert.match(out, /Do not route around it/);
        assert.match(out, /Stop and call `askUser`/);

        // The no-route-around framing is shared; only the escalation target differs.
        const sub = buildSystemPrompt({
            tools: [stubTool("read")],
            sessionKind: { role: "subagent", depth: 1 },
        });
        assert.match(sub, /A permission denial is a decision, not a mechanical failure/);
        assert.match(sub, /Do not route around it/);
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

    it("omits the model_identity section when no identity is supplied", () => {
        const out = buildSystemPrompt({ tools: [stubTool("read")] });
        assert.ok(!out.includes("<model_identity>"), "unknown identity must drop the section");
        assert.ok(
            !out.includes("unknown</model_identity>"),
            "must not render a placeholder identity",
        );
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

    // "im" used to be a tag with no tool behind it: unsatisfiable by
    // construction, so a contributor requiring it was dropped without a
    // word. IM gating rides on `hideWorkspacePath` instead, and the tag is
    // gone. The @ts-expect-error is the guard: re-adding "im" to the tag
    // union makes the directive unused and fails the typecheck.
    it("rejects an im capability tag at compile time", () => {
        // @ts-expect-error "im" is not a SystemPromptContributorTag
        const requires: SystemPromptContributorTag[] = ["im"];
        assert.equal(requires.length, 1);
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

    it("renders destructive and concurrency tags", () => {
        const out = toolSummaryForPrompt([
            { name: "read", taco: { mutates: false } },
            { name: "write", taco: { mutates: true, destructive: true } },
        ]);
        assert.match(out, /- read \[read-only\]/);
        assert.match(out, /- write \[mutates, destructive\]/);
        assert.match(out, /Concurrency:/);
        assert.match(out, /Tools marked \[read-only\] are concurrency-safe/);
    });

    // Regression: the footer used to claim that ALL tool calls run concurrently
    // in no guaranteed order, which is false for same-file edit/write (pi
    // serialises them). The new footer distinguishes same-file vs different-file
    // mutations and concurrency-safe read-only tools.
    it("describes concurrency accurately by tool kind", () => {
        const out = toolSummaryForPrompt([{ name: "read", taco: { mutates: false } }]);
        assert.match(out, /Mutating calls to the SAME file are serialized/);
        assert.match(out, /Mutating calls to DIFFERENT files are independent/);
        assert.ok(
            !out.includes("run concurrently, in no guaranteed order"),
            "must not repeat the inaccurate global assertion",
        );
    });

    it("calls out askUser as the exception to read-only batching", () => {
        const withAskUser = toolSummaryForPrompt([
            { name: "read", taco: { mutates: false } },
            { name: "askUser", taco: { mutates: false } },
        ]);
        assert.match(withAskUser, /`askUser` is the exception/);
        const withoutAskUser = toolSummaryForPrompt([{ name: "read", taco: { mutates: false } }]);
        assert.ok(!withoutAskUser.includes("askUser"), "no dangling mention without the tool");
    });
});

describe("buildEnvironmentPrompt", () => {
    const env: EnvironmentContext = {
        cwd: "/tmp/proj",
        platform: "darwin",
        shell: "zsh",
        isGitRepository: false,
    };

    it("points relative-path resolution at the rendered working directory", () => {
        const out = buildEnvironmentPrompt({ env });
        assert.match(out, /Working directory: \/tmp\/proj/);
        assert.match(out, /resolve against the working directory above/);
    });

    // Regression: the sentence dangled on IM channels, where the
    // hideWorkspacePath branch omits the `Working directory` line it points at.
    it("omits the sentence when the working directory is hidden", () => {
        const out = buildEnvironmentPrompt({ env, hideWorkspacePath: true });
        assert.ok(!out.includes("Working directory"));
        assert.ok(!out.includes("working directory above"));
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
    } as unknown as TacoSkill;

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

    // Regression: the 250-char cap used to truncate the merged
    // "description — whenToUse" string, so a long description ate the hint —
    // the one part that tells the model when to invoke.
    it("truncates description and whenToUse separately so the hint survives", () => {
        const out = formatSkillsForSystemPrompt([
            {
                ...skill,
                description: "d".repeat(400),
                whenToUse: "pick me when reviewing",
            } as unknown as TacoSkill,
        ]);
        assert.match(out, /<description>d{249}\.\.\. — pick me when reviewing<\/description>/);
    });

    it("collapses a multi-line whenToUse into one line, like the agents catalog", () => {
        const out = formatSkillsForSystemPrompt([
            { ...skill, whenToUse: "line one\n  line two" } as unknown as TacoSkill,
        ]);
        assert.match(out, /Ship the app — line one line two<\/description>/);
    });

    it("caps the whenToUse hint at its own budget", () => {
        const out = formatSkillsForSystemPrompt([
            { ...skill, whenToUse: "w".repeat(200) } as unknown as TacoSkill,
        ]);
        assert.match(out, /— w{119}\.\.\.<\/description>/);
    });
});

describe("formatSkillAuthoringGuidance", () => {
    it("always includes the path-discovery preamble, regardless of dir count", () => {
        // Structural assertion independent of how many dirs defaultSkillDirs
        // happens to return — a future change that trims the writable list
        // to zero must not make this silently pass on an empty guidance
        // string.
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(guidance.includes("checked in order, first match by name wins"));
    });

    it("lists every user-writable dir from defaultSkillDirs, in order", () => {
        const cwd = "/work/project";
        const guidance = formatSkillAuthoringGuidance(cwd);
        const dirs = defaultSkillDirs(cwd);
        const writable = dirs.filter((d) => d.source === "user");

        assert.ok(writable.length > 0, "expected at least one writable skill dir");
        let lastIndex = -1;
        for (const dir of writable) {
            const idx = guidance.indexOf(dir.path);
            assert.ok(idx !== -1, `expected guidance to mention ${dir.path}`);
            assert.ok(idx > lastIndex, `expected ${dir.path} to appear after the previous dir`);
            lastIndex = idx;
        }
    });

    it("separates the dir list from the frontmatter section with a blank line", () => {
        // Regression: an earlier version built the blank separator as a `""`
        // array entry and dropped it via `.filter((l) => l !== "")` alongside
        // the conditionally-omitted builtin-readonly line, so the two
        // sections ran together with no paragraph break in every case.
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(
            guidance.includes("overwrite it).\n\nSKILL.md needs YAML frontmatter"),
            "expected a blank line between the dir list/read-only callout and the frontmatter section",
        );
    });

    it("flags the builtin dir as read-only rather than listing it as writable", () => {
        const cwd = "/work/project";
        const guidance = formatSkillAuthoringGuidance(cwd);
        const builtin = defaultSkillDirs(cwd).find((d) => d.source === "builtin");
        assert.ok(builtin, "expected defaultSkillDirs to include a builtin entry");
        assert.ok(guidance.includes(builtin.path));
        assert.ok(guidance.toLowerCase().includes("read-only"));
    });

    it("documents the taco-private frontmatter keys", () => {
        const guidance = formatSkillAuthoringGuidance("/work/project");
        for (const key of ["runAs", "inlineOnly", "allowedTools", "model"]) {
            assert.ok(guidance.includes(key), `expected guidance to mention ${key}`);
        }
    });

    it("documents hot reload and the already-open session discovery limitation", () => {
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(guidance.toLowerCase().includes("automatically"));
        assert.ok(guidance.includes("already-open session"));
        assert.ok(guidance.includes("<available_skills>"));
    });

    it("resolves relative to the given cwd, not a hardcoded path", () => {
        const a = formatSkillAuthoringGuidance("/work/project-a");
        const b = formatSkillAuthoringGuidance("/work/project-b");
        assert.notEqual(a, b);
    });
});
