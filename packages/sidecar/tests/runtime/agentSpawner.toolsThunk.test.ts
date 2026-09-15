/**
 * AgentSpawner reads the parent toolset through a thunk, not a snapshot.
 *
 * `WorkspaceRuntime.refreshToolset()` replaces `this.tools` per turn (IM
 * policy grants, extension changes). AgentSpawner used to copy that array at
 * construction (`getTools: () => this.tools` was `tools: this.tools`), so a
 * tool granted to the parent after the workspace was built stayed invisible
 * to every subagent for the life of the process, even though the parent
 * session itself picked the grant up on its next turn.
 *
 * The child's tool list is captured by stubbing `attachChild` — spawn wraps
 * attach failures into `{ isError: true }`, so throwing from the stub lets us
 * read the tools without a real LLM harness (same technique as
 * agentSpawner.instructionsThunk.test.ts).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoTool } from "../../src/tools/index.ts";

const defs: AgentDefinition[] = [
    // tools: undefined = inherit everything the parent currently has.
    {
        agentType: "coder",
        description: "writes code",
        systemPrompt: "you code",
        tools: undefined,
        source: "builtin",
        filePath: "/x/coder.md",
    },
];

const SHELL_DENY_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
};
const SHELL_ALLOW_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
};

describe("AgentSpawner parent-toolset inheritance", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;
    /** Tool name lists handed to attachChild, in call order. */
    let captured: string[][];
    let policy: ImWorkspacePolicy;

    before(async () => {
        cwd = mkdtempSync(join(tmpdir(), "taco-ws-tools-thunk-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sessions-tools-thunk-"));
        policy = SHELL_DENY_POLICY;
        ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd,
            sessionsRoot,
            agents: defs,
            resolveImPolicy: () => policy,
        } as ConstructorParameters<typeof WorkspaceRuntime>[0]);
        captured = [];
        ws.sessionRegistry.attachChild = (
            _sessionId: never,
            _opts: never,
            tools: TacoTool[],
            _taskState: never,
            _systemPrompt?: string,
        ) => {
            captured.push(tools.map((t) => t.name));
            return Promise.reject(new Error("attach stubbed"));
        };
        await ws.repo
            .create({ id: "parent-1", cwd }, harnessContext)
            .then((s) => s.close(harnessContext));
    });

    after(async () => {
        await ws.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    async function spawnAndCapture(toolCallId: string): Promise<string[]> {
        const res = await ws.spawnSubagent({
            parentSessionId: asSessionId("parent-1"),
            parentToolCallId: toolCallId,
            agentType: "coder",
            prompt: "go",
        });
        assert.equal(res.isError, true, "stubbed attach should surface as isError");
        const names = captured.at(-1);
        assert.ok(names !== undefined, "attachChild should have been reached");
        return names;
    }

    it("a subagent spawned before the grant does not see shell", async () => {
        const names = await spawnAndCapture("tc-before-grant");
        assert.ok(!names.includes("shell"));
    });

    it("a subagent spawned after a per-turn toolset refresh sees the newly granted tool", async () => {
        // Simulate what a real turn does: the policy changes, then the next
        // turn calls refreshToolset() (here invoked directly, standing in for
        // the per-turn call AttachedSession.applyToolsetRefresh makes).
        policy = SHELL_ALLOW_POLICY;
        const changed = ws.refreshToolset(
            "parent-1" as never,
            { taskStore: undefined, tasksDir: cwd, planState: undefined } as never,
        );
        assert.ok(changed, "policy flip must be detected as a toolset change");

        const names = await spawnAndCapture("tc-after-grant");
        assert.ok(
            names.includes("shell"),
            `subagent must see the tool granted to the parent, got: ${names.join(", ")}`,
        );
    });
});
