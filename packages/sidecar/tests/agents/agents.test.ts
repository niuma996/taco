import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { filterToolsForAgent, isToolVisibleForAnySubagent } from "../../src/agents/filterTools.ts";
import {
    buildForkedContext,
    estimateTokens,
    resolveContextMode,
} from "../../src/agents/forkedHistory.ts";
import { loadAgents, parseAgentMarkdown } from "../../src/agents/loadAgents.ts";
import { isStrictReadOnly } from "../../src/permissions/commandPolicy.ts";
import type { AgentHarnessTool, Entry, ExecutionToolContext } from "../../src/runtime/pi/types.ts";
import { READ_ONLY_SHELL_AGENT_TYPES } from "../../src/runtime/subagent/childAttach.ts";

describe("filterTools", () => {
    type AgentTool = AgentHarnessTool<ExecutionToolContext>;

    function fakeTool(name: string): AgentTool {
        return {
            name,
            label: name,
            description: "",
            parameters: {} as never,
            executionMode: "parallel",
            execute: async () => ({ content: [], details: undefined }),
        } as unknown as AgentTool;
    }

    const available = ["read", "write", "edit", "grep", "glob", "shell", "agent"].map(fakeTool);

    describe("filterToolsForAgent", () => {
        it("intersects whitelist with available tools", () => {
            const out = filterToolsForAgent(available, ["read", "grep", "glob"], 1).map(
                (t) => t.name,
            );
            assert.deepEqual(out.sort(), ["glob", "grep", "read"]);
        });

        it("matches the unified shell tool", () => {
            const out = filterToolsForAgent(available, ["read", "shell"], 1).map((t) => t.name);
            assert.deepEqual(out.sort(), ["read", "shell"]);
        });

        it("drops names not in available set", () => {
            const out = filterToolsForAgent(available, ["read", "unknown"], 1).map((t) => t.name);
            assert.deepEqual(out, ["read"]);
        });

        it("removes agent tool when depth>=1 even if whitelisted", () => {
            const out = filterToolsForAgent(available, ["read", "agent"], 1).map((t) => t.name);
            assert.ok(!out.includes("agent"));
        });

        it("keeps agent tool when depth=0 (parent session)", () => {
            const out = filterToolsForAgent(available, ["read", "agent"], 0).map((t) => t.name);
            assert.ok(out.includes("agent"));
        });

        it("undefined whitelist = all available minus agent (depth>=1)", () => {
            const out = filterToolsForAgent(available, undefined, 1).map((t) => t.name);
            assert.ok(!out.includes("agent"));
            assert.ok(out.includes("read") && out.includes("shell") && out.includes("grep"));
        });

        // Regression: these tools end the run to wait for the user, but answers are
        // only submitted to the parent session — in a child they were unanswerable.
        const interactive = ["askUser", "planEnter", "planExit"];
        const withInteractive = [...available, ...interactive.map(fakeTool)];

        it("strips user-interaction tools from an inheriting subagent (depth>=1)", () => {
            const out = filterToolsForAgent(withInteractive, undefined, 1).map((t) => t.name);
            for (const name of interactive)
                assert.ok(!out.includes(name), `${name} must be stripped`);
            assert.ok(out.includes("read") && out.includes("shell"));
        });

        it("strips user-interaction tools even when whitelisted (depth>=1)", () => {
            const out = filterToolsForAgent(withInteractive, ["read", ...interactive], 1).map(
                (t) => t.name,
            );
            assert.deepEqual(out, ["read"]);
        });

        it("keeps user-interaction tools for the parent session (depth=0)", () => {
            const out = filterToolsForAgent(withInteractive, undefined, 0).map((t) => t.name);
            for (const name of [...interactive, "agent"]) assert.ok(out.includes(name));
        });
    });

    describe("isToolVisibleForAnySubagent", () => {
        it("reports main-session-only tools as invisible, even to inheriting agents", () => {
            for (const name of ["agent", "askUser", "planEnter", "planExit"]) {
                assert.equal(isToolVisibleForAnySubagent(name, [undefined]), false, name);
                assert.equal(isToolVisibleForAnySubagent(name, [[name]]), false, name);
            }
        });

        it("still reports ordinary tools by whitelist", () => {
            assert.equal(isToolVisibleForAnySubagent("read", [undefined]), true);
            assert.equal(isToolVisibleForAnySubagent("read", [["read"]]), true);
            assert.equal(isToolVisibleForAnySubagent("write", [["read"]]), false);
        });
    });
});

describe("forkedHistory", () => {
    /** Minimal message entries; cast once so the tests read as fixtures, not wire types. */
    function entries(
        msgs: Array<{ role: "user" | "assistant" | "toolResult"; text: string }>,
    ): Entry[] {
        return msgs.map((m, i) => ({
            type: "message",
            id: `id-${i}`,
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: m.role, content: m.text },
        })) as unknown as Entry[];
    }

    describe("resolveContextMode", () => {
        // All 9 (arg, def) combinations. The call site wins whenever it is set —
        // including when it asks to DOWNGRADE a fork-declaring profile back to
        // independent. Silently ignoring that would make the tool parameter lie.
        const cases: Array<{
            arg: "independent" | "fork" | undefined;
            def: "independent" | "fork" | undefined;
            want: "independent" | "fork";
        }> = [
            { arg: undefined, def: undefined, want: "independent" },
            { arg: undefined, def: "independent", want: "independent" },
            { arg: undefined, def: "fork", want: "fork" },
            { arg: "independent", def: undefined, want: "independent" },
            { arg: "independent", def: "independent", want: "independent" },
            { arg: "independent", def: "fork", want: "independent" },
            { arg: "fork", def: undefined, want: "fork" },
            { arg: "fork", def: "independent", want: "fork" },
            { arg: "fork", def: "fork", want: "fork" },
        ];

        for (const { arg, def, want } of cases) {
            it(`arg=${String(arg)} def=${String(def)} → ${want}`, () => {
                assert.equal(resolveContextMode(arg, def), want);
            });
        }
    });

    describe("estimateTokens", () => {
        it("counts CJK chars ~1 token each and ASCII ~4 chars/token", () => {
            assert.equal(estimateTokens("你好"), 2);
            assert.equal(estimateTokens("abcd"), 1);
            assert.equal(estimateTokens("abcde"), 2);
        });
    });

    describe("buildForkedContext", () => {
        it("returns undefined when there is no displayable text", () => {
            assert.equal(buildForkedContext([]), undefined);
            // toolResult-only branch has no user/assistant text.
            assert.equal(
                buildForkedContext(entries([{ role: "toolResult", text: "shell output" }])),
                undefined,
            );
        });

        it("keeps the first message and backfills from the newest, skipping toolResults", () => {
            const ctx = buildForkedContext(
                entries([
                    { role: "user", text: "original task" },
                    { role: "assistant", text: "first assistant reply" },
                    { role: "toolResult", text: "tool output (dropped)" },
                    { role: "user", text: "follow-up question" },
                    { role: "assistant", text: "final answer" },
                ]),
            );
            assert.ok(ctx, "expected a rendered block");
            assert.ok(ctx.includes("[user]\noriginal task"), "head kept");
            assert.ok(ctx.includes("[assistant]\nfinal answer"), "tail backfilled");
            assert.ok(
                ctx.includes("[user]\nfollow-up question"),
                "interior kept when budget allows",
            );
            assert.ok(!ctx.includes("tool output"), "toolResult content dropped");
            assert.ok(!ctx.includes("…[earlier messages omitted]…"), "nothing omitted");
            assert.ok(ctx.includes("<forked_context>") && ctx.includes("</forked_context>"));
        });

        it("marks omitted messages when the budget forces a gap", () => {
            // Budget fits the head + the newest message but not the long middle
            // message; the middle must drop out, leaving an omission marker.
            const msgs = entries([
                { role: "user", text: "first" },
                { role: "assistant", text: "m".repeat(200) },
                { role: "assistant", text: "last" },
            ]);
            const ctx = buildForkedContext(msgs, { maxTokens: 7 });
            assert.ok(ctx, "expected a rendered block");
            assert.ok(ctx.includes("[user]\nfirst"), "head kept");
            assert.ok(ctx.includes("[assistant]\nlast"), "tail kept");
            assert.ok(!ctx.includes("m".repeat(200)), "middle dropped");
            assert.ok(ctx.includes("…[earlier messages omitted]…"), "gap marked");
        });

        it("truncates when the head alone exceeds the budget", () => {
            const ctx = buildForkedContext(entries([{ role: "user", text: "a very long task" }]), {
                maxTokens: 2,
            });
            assert.ok(ctx, "expected a rendered block");
            assert.ok(ctx.includes("…[truncated]…"), "head truncated to budget");
        });
    });
});

describe("loadAgents", () => {
    describe("parseAgentMarkdown", () => {
        it("parses frontmatter + body", () => {
            const md =
                "---\nname: explorer\ndescription: read-only\ntools:\n  - read\n  - grep\nmaxTurns: 30\n---\nYou are an explorer.";
            const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
            assert.ok(def, "expected parseAgentMarkdown to return non-null");
            assert.equal(def.agentType, "explorer");
            assert.equal(def.description, "read-only");
            assert.deepEqual(def.tools, ["read", "grep"]);
            assert.equal(def.maxTurns, 30);
            assert.equal(def.systemPrompt, "You are an explorer.");
            assert.equal(def.timeoutMinutes, undefined);
        });

        it("parses timeoutMinutes from frontmatter", () => {
            const md = "---\nname: explorer\ntimeoutMinutes: 15\n---\nbody";
            const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
            assert.ok(def);
            assert.equal(def.timeoutMinutes, 15);
        });

        it("drops non-positive or non-numeric timeoutMinutes", () => {
            assert.equal(
                parseAgentMarkdown("---\nname: a\ntimeoutMinutes: 0\n---\nbody", "/x/a.md", "user")
                    ?.timeoutMinutes,
                undefined,
            );
            assert.equal(
                parseAgentMarkdown("---\nname: a\ntimeoutMinutes: -2\n---\nbody", "/x/a.md", "user")
                    ?.timeoutMinutes,
                undefined,
            );
            assert.equal(
                parseAgentMarkdown(
                    "---\nname: a\ntimeoutMinutes: nope\n---\nbody",
                    "/x/a.md",
                    "user",
                )?.timeoutMinutes,
                undefined,
            );
        });

        it("returns null when name missing", () => {
            const def = parseAgentMarkdown("---\ndescription: x\n---\nbody", "/x/bad.md", "user");
            assert.equal(def, null);
        });

        it("no frontmatter returns null (no agentType)", () => {
            const def = parseAgentMarkdown("just a body, no frontmatter here", "/x/raw.md", "user");
            assert.equal(def, null);
        });

        it("parses fewShots from frontmatter", () => {
            const md = [
                "---",
                "name: explorer",
                "description: x",
                "fewShots:",
                "  - user: where is foo?",
                "    assistant: foo is at src/foo.ts:42.",
                "  - user: |",
                "      multiline user",
                "      request",
                "    assistant: |",
                "      multiline assistant",
                "      answer",
                "---",
                "body",
            ].join("\n");
            const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
            assert.ok(def);
            assert.equal(def.fewShots?.length, 2);
            assert.equal(def.fewShots?.[0].user, "where is foo?");
            assert.equal(def.fewShots?.[0].assistant, "foo is at src/foo.ts:42.");
            assert.equal(def.fewShots?.[1].user, "multiline user\nrequest");
            assert.equal(def.fewShots?.[1].assistant, "multiline assistant\nanswer");
        });

        it("drops fewShots items missing a field", () => {
            const md = [
                "---",
                "name: explorer",
                "description: x",
                "fewShots:",
                "  - user: only user",
                "  - assistant: only assistant",
                "  - user: |",
                "      valid pair",
                "    assistant: |",
                "      with both fields",
                "---",
                "body",
            ].join("\n");
            const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
            assert.ok(def);
            // The two malformed items drop out; only the third (valid pair) remains.
            assert.equal(def.fewShots?.length, 1);
            assert.equal(def.fewShots?.[0].user, "valid pair");
        });

        it("omits fewShots when frontmatter key is absent", () => {
            const md = "---\nname: x\ndescription: y\n---\nbody";
            const def = parseAgentMarkdown(md, "/x/x.md", "builtin");
            assert.ok(def);
            assert.equal(def.fewShots, undefined);
        });

        it("parses context from frontmatter", () => {
            const def = parseAgentMarkdown(
                "---\nname: reviewer\ndescription: x\ncontext: fork\n---\nbody",
                "/x/reviewer.md",
                "builtin",
            );
            assert.ok(def);
            assert.equal(def.context, "fork");
        });

        it("omits context when the frontmatter key is absent or invalid", () => {
            const absent = parseAgentMarkdown(
                "---\nname: x\ndescription: y\n---\nbody",
                "/x/x.md",
                "builtin",
            );
            assert.equal(absent?.context, undefined);
            const invalid = parseAgentMarkdown(
                "---\nname: x\ndescription: y\ncontext: bogus\n---\nbody",
                "/x/x.md",
                "builtin",
            );
            assert.equal(invalid?.context, undefined);
        });

        it("parses runtime, falling back to undefined (standard) for an unknown value", () => {
            const cc = parseAgentMarkdown(
                "---\nname: x\ndescription: y\nruntime: claude-code\n---\nbody",
                "/x/x.md",
                "user",
            );
            assert.equal(cc?.runtime, "claude-code");
            const bogus = parseAgentMarkdown(
                "---\nname: x\ndescription: y\nruntime: codex\n---\nbody",
                "/x/x.md",
                "user",
            );
            assert.ok(bogus);
            assert.equal(bogus.runtime, undefined);
            const explicit = parseAgentMarkdown(
                "---\nname: x\ndescription: y\nruntime: standard\n---\nbody",
                "/x/x.md",
                "user",
            );
            assert.equal(explicit?.runtime, "standard");
        });
    });

    describe("loadAgents", () => {
        let userDir: string;
        before(() => {
            userDir = mkdtempSync(join(tmpdir(), "taco-agents-"));
        });
        after(() => rmSync(userDir, { recursive: true, force: true }));

        it("loads agents from a given builtin dir", async () => {
            const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
            writeFileSync(
                join(builtinDir, "explorer.md"),
                "---\nname: explorer\ndescription: builtin x\n---\nbuiltin body",
            );
            try {
                const agents = await loadAgents({ builtinDir, userDirs: [userDir] });
                const explorer = agents.find((a) => a.agentType === "explorer");
                assert.ok(explorer, "expected builtin explorer");
                assert.equal(explorer.description, "builtin x");
                assert.equal(explorer.source, "builtin");
            } finally {
                rmSync(builtinDir, { recursive: true, force: true });
            }
        });

        it("user agent overrides builtin of same name", async () => {
            const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
            writeFileSync(
                join(builtinDir, "explorer.md"),
                "---\nname: explorer\ndescription: builtin version\n---\nbody",
            );
            writeFileSync(
                join(userDir, "explorer.md"),
                "---\nname: explorer\ndescription: USER override\n---\ncustom",
            );
            try {
                const agents = await loadAgents({ builtinDir, userDirs: [userDir] });
                const explorer = agents.find((a) => a.agentType === "explorer");
                assert.equal(explorer?.description, "USER override");
                assert.equal(explorer?.source, "user");
            } finally {
                rmSync(builtinDir, { recursive: true, force: true });
            }
        });

        it("missing user dir is silently ignored", async () => {
            const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
            writeFileSync(
                join(builtinDir, "explorer.md"),
                "---\nname: explorer\ndescription: x\n---\nbody",
            );
            try {
                const agents = await loadAgents({
                    builtinDir,
                    userDirs: ["/nonexistent/path/should/not/exist/xyz"],
                });
                assert.ok(agents.find((a) => a.agentType === "explorer"));
            } finally {
                rmSync(builtinDir, { recursive: true, force: true });
            }
        });
    });
});

describe("readOnlyShellGate", () => {
    const BUILTIN_DIR = join(import.meta.dirname, "..", "..", "src", "agents", "builtin");

    /**
     * The banner a profile uses to claim it cannot write anything at all.
     *
     * Deliberately narrower than "mentions not modifying files": `verification`
     * says "DO NOT MODIFY THE PROJECT" yet must keep a writable shell, since it
     * runs builds and writes ephemeral scripts to /tmp. Only the absolute
     * no-modifications banner implies the read-only broker.
     */
    const READ_ONLY_BANNER = /READ-ONLY MODE - NO FILE MODIFICATIONS/i;

    describe("read-only shell gate", () => {
        it("every builtin profile granted shell that claims read-only is gated", async () => {
            // userDirs: [] — same rationale as server.agents.test.ts, avoids host-fs drift.
            const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
            assert.ok(agents.length > 0, "expected builtin agents to load");

            const ungated: string[] = [];
            for (const a of agents) {
                const grantsShell = a.tools === undefined || a.tools.includes("shell");
                const claimsReadOnly = READ_ONLY_BANNER.test(a.systemPrompt);
                if (
                    grantsShell &&
                    claimsReadOnly &&
                    !READ_ONLY_SHELL_AGENT_TYPES.has(a.agentType)
                ) {
                    ungated.push(a.agentType);
                }
            }
            assert.deepEqual(
                ungated,
                [],
                `these profiles claim read-only and hold shell but are not in READ_ONLY_SHELL_AGENT_TYPES: ${ungated.join(", ")}`,
            );
        });

        it("reviewer is gated — it holds shell and its body forbids writes", async () => {
            const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
            const reviewer = agents.find((a) => a.agentType === "reviewer");
            assert.ok(reviewer, "expected the reviewer builtin");
            assert.ok(reviewer.tools?.includes("shell"), "reviewer is granted shell");
            assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("reviewer"), true);
        });

        it("verification is NOT gated — it must keep a writable shell", () => {
            // It runs builds and writes ephemeral scripts to /tmp; swapping in the
            // read-only broker would make the profile unable to do its job.
            assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("verification"), false);
        });

        it("reviewer defaults to forked context", async () => {
            const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
            const reviewer = agents.find((a) => a.agentType === "reviewer");
            assert.equal(reviewer?.context, "fork");
        });

        it("every shell command reviewer.md names as allowed actually passes the read-only gate", async () => {
            // The doc tells the model which shell commands it may run. Each such
            // base command must survive isStrictReadOnly, or the profile instructs
            // the model to run things the broker will deny — wasted turns and false
            // "cannot verify" reports. Extract the promised commands from the doc
            // itself and bind them to the real allowlist. Mutating git siblings
            // (`git branch -D`, `git checkout`) stay out of the promised list even
            // though the `git branch` listing form now auto-allows.
            const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
            const reviewer = agents.find((a) => a.agentType === "reviewer");
            assert.ok(reviewer, "expected the reviewer builtin");
            const promised = [...reviewer.systemPrompt.matchAll(/`((?:git )?[a-z][a-z -]*?)`/g)]
                .map((m) => m[1].trim())
                .filter((s) => /^(pwd|ls|which|git )/.test(s));
            // Sanity: the doc must promise exactly the base commands the gate accepts
            // and nothing it denies.
            assert.deepEqual(
                [...promised].sort(),
                [
                    "git blame",
                    "git branch",
                    "git diff",
                    "git log",
                    "git ls-files",
                    "git rev-parse",
                    "git show",
                    "git status",
                    "ls",
                    "pwd",
                    "which",
                ],
                "reviewer.md's promised shell commands drifted from the read-only allowlist",
            );
            for (const cmd of promised) {
                assert.ok(
                    isStrictReadOnly(cmd),
                    `reviewer.md promises "${cmd}" but the read-only broker denies it`,
                );
            }
            // The doc must NOT tell the model it can run builds/tests — those are
            // denied; the profile points at `verification` for execution instead.
            assert.ok(
                !/run a build\/test to verify[^.]*allowed/i.test(reviewer.systemPrompt),
                "reviewer.md must not claim builds/tests are allowed — the broker denies them",
            );
        });
    });
});
