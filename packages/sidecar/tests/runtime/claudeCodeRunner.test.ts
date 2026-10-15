/**
 * runClaudeCodeSubagent against a fake SDK — no real CLI or network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import {
    CLAUDE_CODE_TOOL_PRESET,
    DEFAULT_CLAUDE_CODE_MAX_TURNS,
    runClaudeCodeSubagent,
} from "../../src/runtime/subagent/claudeCode/claudeCodeRunner.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";

const subSessionId = asSessionId("child-1");

function fakeSdk(
    frames: (options: SdkQueryOptions) => AsyncIterable<SdkMessage>,
    seen: { options?: SdkQueryOptions; prompt?: string } = {},
): ClaudeAgentSdk {
    return {
        query({ prompt, options }) {
            seen.options = options;
            seen.prompt = prompt;
            return frames(options);
        },
    };
}

async function* reply(text: string, subtype = "success"): AsyncIterable<SdkMessage> {
    yield { type: "system", subtype: "init" };
    yield { type: "assistant", message: { id: "a1", content: [{ type: "text", text }] } };
    yield { type: "result", subtype, is_error: subtype !== "success", result: text, num_turns: 1 };
}

function baseArgs(sdk: ClaudeAgentSdk, appended: AgentMessage[] = []) {
    return {
        subSessionId,
        agentType: "cc",
        prompt: "do it",
        cwd: "/work",
        abortController: new AbortController(),
        appendMessages: async (ms: AgentMessage[]) => {
            appended.push(...ms);
        },
        loadSdk: async () => sdk,
        findExecutable: () => "/usr/local/bin/claude",
    };
}

describe("runClaudeCodeSubagent", () => {
    it("marks an already-aborted run as aborted, not as a plain failure", async () => {
        const args = baseArgs(fakeSdk(() => reply("never used")));
        args.abortController.abort();
        const r = await runClaudeCodeSubagent(args);
        assert.equal(r.isError, true);
        assert.equal(r.aborted, true);
        assert.equal(r.subSessionId, subSessionId);
    });

    it("returns the final reply and persists prompt + transcript", async () => {
        const appended: AgentMessage[] = [];
        const r = await runClaudeCodeSubagent(
            baseArgs(
                fakeSdk(() => reply("done")),
                appended,
            ),
        );
        assert.deepEqual(r, { subSessionId, resultText: "done", isError: false });
        assert.deepEqual(
            appended.map((m) => m.role),
            ["user", "assistant"],
        );
    });

    it("passes Claude Code's own toolset and permission system to the SDK", async () => {
        const seen: { options?: SdkQueryOptions; prompt?: string } = {};
        await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("ok"), seen)),
            rolePrompt: "be brief",
        });
        const o = seen.options;
        assert.ok(o);
        assert.deepEqual(o.tools, CLAUDE_CODE_TOOL_PRESET);
        assert.equal(o.permissionMode, "auto");
        assert.equal(o.allowDangerouslySkipPermissions, undefined);
        // taco has no surface for Claude Code prompts: nothing may wait on one.
        assert.equal(o.permissionPrompts, "none");
        assert.equal("canUseTool" in o, false);
        // AskUserQuestion would open an interactive prompt no one can answer;
        // blocked even when a definition's tool list names it.
        assert.deepEqual(o.disallowedTools, ["AskUserQuestion"]);
        assert.deepEqual(o.settingSources, ["user"]);
        assert.equal(o.persistSession, false);
        assert.equal(o.strictMcpConfig, true);
        assert.deepEqual(o.mcpServers, {});
        assert.equal(o.cwd, "/work");
        assert.equal(o.maxTurns, DEFAULT_CLAUDE_CODE_MAX_TURNS);
        assert.equal(o.systemPrompt.append, "be brief");
        assert.equal(seen.prompt, "do it");
    });

    it("narrows tools to an explicit list when the definition names one", async () => {
        const seen: { options?: SdkQueryOptions } = {};
        await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("ok"), seen)),
            tools: ["Read", "Edit"],
        });
        assert.deepEqual(seen.options?.tools, ["Read", "Edit"]);
    });

    it("passes no permission mode for inherit, so Claude Code picks its own", async () => {
        const seen: { options?: SdkQueryOptions } = {};
        await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("ok"), seen)),
            permissionMode: "inherit",
        });
        assert.ok(seen.options);
        assert.equal("permissionMode" in seen.options, false);
    });

    it("pairs bypassPermissions with the SDK's required opt-in flag", async () => {
        const seen: { options?: SdkQueryOptions } = {};
        await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("ok"), seen)),
            permissionMode: "bypassPermissions",
        });
        assert.equal(seen.options?.permissionMode, "bypassPermissions");
        assert.equal(seen.options?.allowDangerouslySkipPermissions, true);
    });

    it("does not hand taco-injected provider keys to the CLI", async () => {
        const store = new ProviderKeyStore({ anthropic: "sk-taco-injected" });
        try {
            const seen: { options?: SdkQueryOptions } = {};
            await runClaudeCodeSubagent(baseArgs(fakeSdk(() => reply("ok"), seen)));
            assert.ok(seen.options);
            assert.ok(!Object.values(seen.options.env).includes("sk-taco-injected"));
        } finally {
            store.update({ anthropic: "" });
        }
    });

    it("reports a missing SDK as a readable error", async () => {
        const r = await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("x"))),
            loadSdk: async () => {
                throw new Error("Claude Code subagents need the optional package");
            },
        });
        assert.equal(r.isError, true);
        assert.match(r.resultText, /optional package/);
    });

    it("reports a missing CLI as a readable error", async () => {
        const r = await runClaudeCodeSubagent({
            ...baseArgs(fakeSdk(() => reply("x"))),
            findExecutable: () => undefined,
        });
        assert.equal(r.isError, true);
        assert.match(r.resultText, /Claude Code CLI .* on PATH/);
    });

    it("treats a 'success' result with no assistant reply as an error (e.g. not logged in)", async () => {
        async function* notLoggedIn(): AsyncIterable<SdkMessage> {
            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "Not logged in · Please run /login",
                num_turns: 1,
            };
        }
        const r = await runClaudeCodeSubagent(baseArgs(fakeSdk(notLoggedIn)));
        assert.equal(r.isError, true);
    });

    it("degrades a turn-capped run to a partial answer", async () => {
        async function* capped(): AsyncIterable<SdkMessage> {
            yield {
                type: "assistant",
                message: { id: "a1", content: [{ type: "text", text: "half" }] },
            };
            yield { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3 };
        }
        const r = await runClaudeCodeSubagent({ ...baseArgs(fakeSdk(capped)), maxTurns: 3 });
        assert.equal(r.isError, false);
        assert.match(r.resultText, /^\[partial: stopped after reaching the 3-turn limit\]\nhalf$/);
    });

    it("stops when the controller aborts mid-run and reports a deliberate stop", async () => {
        const args = baseArgs(
            fakeSdk((options) =>
                (async function* () {
                    yield {
                        type: "assistant",
                        message: { id: "a1", content: [{ type: "text", text: "working" }] },
                    } as SdkMessage;
                    options.abortController.abort();
                    throw new Error("Claude Code process aborted by user");
                })(),
            ),
        );
        const r = await runClaudeCodeSubagent(args);
        assert.equal(r.isError, true);
        assert.match(r.resultText, /deliberate interruption/);
    });
});
