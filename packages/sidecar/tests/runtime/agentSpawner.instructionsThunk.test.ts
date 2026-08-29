/**
 * AgentSpawner inherits parent instructions through a thunk, not a snapshot.
 *
 * `settings.write` → `server.refreshInstructions` → `updateInstructionsConfig`
 * re-renders `WorkspaceRuntime.parentInstructionsBlock`. AgentSpawner used to
 * copy that string at construction, so every subagent stayed pinned to the
 * startup config for the life of the process while the parent session picked
 * the change up on its next LLM call.
 *
 * The child's system prompt is captured by stubbing `attachChild` — spawn wraps
 * attach failures into `{ isError: true }`, so throwing from the stub lets us
 * read the prompt without a real LLM harness.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

const defs: AgentDefinition[] = [
    {
        agentType: "coder",
        description: "writes code",
        systemPrompt: "you code",
        source: "builtin",
        filePath: "/x/coder.md",
    },
];

const CLAUDE_MD = "Project rule: always use tabs.";

describe("AgentSpawner parent-instructions inheritance", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;
    /** System prompts handed to attachChild, in call order. */
    let captured: string[];

    before(async () => {
        cwd = mkdtempSync(join(tmpdir(), "taco-ws-instr-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sessions-instr-"));
        writeFileSync(join(cwd, "CLAUDE.md"), CLAUDE_MD);
        ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd,
            sessionsRoot,
            agents: defs,
        });
        captured = [];
        // Abort right after the prompt is built: everything under test happens
        // before attach, and the spawn path turns the throw into an isError
        // result rather than propagating it.
        ws.sessionRegistry.attachChild = (
            _sessionId: never,
            _opts: never,
            _tools: never,
            _taskState: never,
            systemPrompt?: string,
        ) => {
            captured.push(systemPrompt ?? "");
            return Promise.reject(new Error("attach stubbed"));
        };
        await ws.repo.create({ id: "parent-1", cwd });
    });

    after(async () => {
        await ws.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    async function spawnAndCapture(toolCallId: string): Promise<string> {
        const res = await ws.spawnSubagent({
            parentSessionId: "parent-1",
            parentToolCallId: toolCallId,
            agentType: "coder",
            prompt: "go",
        });
        assert.equal(res.isError, true, "stubbed attach should surface as isError");
        const prompt = captured.at(-1);
        assert.ok(prompt !== undefined, "attachChild should have been reached");
        return prompt;
    }

    it("includes the parent CLAUDE.md block in a spawned child's prompt", async () => {
        assert.match(ws.parentInstructionsBlock, /always use tabs/);
        assert.match(await spawnAndCapture("tc-before"), /always use tabs/);
    });

    it("drops the block from the next spawn after instructions are disabled", async () => {
        ws.updateInstructionsConfig({ enabled: false });
        assert.equal(ws.parentInstructionsBlock, "");
        const prompt = await spawnAndCapture("tc-after-disable");
        assert.doesNotMatch(
            prompt,
            /always use tabs/,
            "child must not inherit a block the parent has dropped",
        );
    });

    it("re-adds the block when instructions are turned back on", async () => {
        ws.updateInstructionsConfig(undefined);
        assert.match(ws.parentInstructionsBlock, /always use tabs/);
        assert.match(await spawnAndCapture("tc-after-reenable"), /always use tabs/);
    });
});
