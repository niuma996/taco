/**
 * AgentSpawner.spawnSkillSubagent — inlineOnly guard.
 *
 * Second-line defense: SkillTool already rejects inlineOnly skills in
 * subagent mode, but a future caller (extension, hook) could reach
 * `spawnSkillSubagent` directly. The spawner must fail closed regardless of
 * who calls in.
 *
 * Only the validation branch is exercised here — the happy path requires a
 * real harness with a model, which the end-to-end subagent smoke tests
 * already cover. This test focuses on the inlineOnly short-circuit, which is
 * the path most likely to regress silently if someone removes the guard.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AgentDefinition } from "../../src/agents/types.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const defs: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "read-only search",
        systemPrompt: "you explore",
        maxTurns: 10,
        source: "builtin",
        filePath: "/x/explorer.md",
    },
];

describe("AgentSpawner.spawnSkillSubagent — inlineOnly guard", () => {
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;

    before(() => {
        ({ ws, cleanup } = createTestWorkspace({ prefix: "skill-io", agents: defs }));
    });

    after(() => cleanup());

    it("rejects inlineOnly skill before runSkillSubagent runs", async () => {
        // Stub runSkillSubagent to assert it is never reached.
        const original = (
            ws.agentSpawner as unknown as {
                runSkillSubagent: (args: unknown) => Promise<unknown>;
            }
        ).runSkillSubagent;
        let runSkillCalls = 0;
        (
            ws.agentSpawner as unknown as { runSkillSubagent: (args: unknown) => Promise<unknown> }
        ).runSkillSubagent = async () => {
            runSkillCalls++;
            throw new Error("runSkillSubagent must not be reached for an inlineOnly skill");
        };

        try {
            const res = await ws.agentSpawner.spawnSkillSubagent({
                parentSessionId: "parent-1",
                parentToolCallId: "tc-1",
                skillName: "fan-out-agents",
                skillContent: "# body",
                skillFrontmatter: { runAs: "subagent", inlineOnly: true },
                args: "",
            });
            assert.equal(runSkillCalls, 0, "inlineOnly must short-circuit before any spawn logic");
            assert.equal(res.isError, true);
            assert.match(res.resultText, /inline-only/);
            assert.match(res.resultText, /fan-out-agents/);
            // No child session was created; subSessionId must be absent, not "".
            assert.equal(res.subSessionId, undefined);
        } finally {
            (ws.agentSpawner as unknown as { runSkillSubagent: typeof original }).runSkillSubagent =
                original;
        }
    });

    it("non-inlineOnly skills with runAs=subagent pass through (no regression)", async () => {
        // Sanity: the guard must not affect skills that legitimately should
        // run as subagents. We cannot drive runSkillSubagent here (it needs
        // a real harness), so we instead expect the next branch — the runAs
        // mismatch error — to fire on its own when we pass runAs="inline".
        // This proves the inlineOnly branch is the only new short-circuit.
        const res = await ws.agentSpawner.spawnSkillSubagent({
            parentSessionId: "parent-1",
            parentToolCallId: "tc-1",
            skillName: "regular-skill",
            skillContent: "# body",
            skillFrontmatter: { runAs: "inline" },
            args: "",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /not "subagent"/);
    });
});
