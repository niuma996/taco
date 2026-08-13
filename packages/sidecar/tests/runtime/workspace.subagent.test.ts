/**
 * WorkspaceRuntime subagent primitives — tests only the parts that don't need a real LLM:
 * findAgent routing, spawnSubagent error with unknown agentType, subagent metadata filtering.
 * Constructible without a provider key, so we can test pure logic directly.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

// Subagent row filter (reader-end contract):
// kind === "subagent" + parentSessionId matches + pick sessionId/agentType/parentToolCallId.
function listSubagents(
    rows: JsonlSessionMetadata[],
    parentSessionId: string,
): Array<{ sessionId: string; agentType: string; parentToolCallId: string }> {
    return rows
        .filter((m) => {
            const md = m.metadata as Record<string, unknown> | undefined;
            return md?.kind === "subagent" && md.parentSessionId === parentSessionId;
        })
        .map((m) => {
            const md = m.metadata as Record<string, unknown>;
            return {
                sessionId: m.id,
                agentType: String(md.agentType),
                parentToolCallId: String(md.parentToolCallId),
            };
        });
}

const defs: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "read-only search",
        systemPrompt: "you explore",
        source: "builtin",
        filePath: "/x/explorer.md",
    },
    {
        agentType: "coder",
        description: "writes code",
        systemPrompt: "you code",
        source: "builtin",
        filePath: "/x/coder.md",
    },
];

describe("WorkspaceRuntime subagent primitives", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;

    before(() => {
        cwd = mkdtempSync(join(tmpdir(), "taco-ws-sub-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sessions-sub-"));
        ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd,
            sessionsRoot,
            agents: defs,
        });
    });

    after(async () => {
        await ws.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    it("findAgent returns the matching definition, undefined otherwise", () => {
        assert.equal(ws.findAgent("explorer")?.description, "read-only search");
        assert.equal(ws.findAgent("coder")?.agentType, "coder");
        assert.equal(ws.findAgent("nope"), undefined);
    });

    it("spawnSubagent with unknown agentType returns isError without throwing", async () => {
        // Requires a real parent session (spawnSubagent calls openSession for depth).
        // unknown-type branch short-circuits before openSession, so no real parent is needed.
        const res = await ws.spawnSubagent({
            parentSessionId: "does-not-matter",
            parentToolCallId: "tc0",
            agentType: "ghost",
            prompt: "hi",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /unknown agent type: ghost/);
    });

    it("subagent filter returns empty when no children exist", async () => {
        await ws.repo.create({ id: "parent-1", cwd });
        const subs = listSubagents(await ws.repo.list({ cwd }), "parent-1");
        assert.deepEqual(subs, []);
    });

    it("subagent metadata persisted by repo.create is filtered to matching parent", async () => {
        // Create sub-sessions with metadata directly via repo; this mirrors what
        // spawnSubagent writes. Validates the reader-side filter + mapping logic (no LLM needed).
        const parentId = "parent-2";
        await ws.repo.create({ id: parentId, cwd });
        await ws.repo.create({
            id: "child-a",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "explorer",
                parentSessionId: parentId,
                parentToolCallId: "tc1",
                depth: 1,
            },
        });
        await ws.repo.create({
            id: "child-b",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "coder",
                parentSessionId: parentId,
                parentToolCallId: "tc2",
                depth: 1,
            },
        });
        // Subagent for a different parent — must not be mixed in
        await ws.repo.create({
            id: "child-other",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "explorer",
                parentSessionId: "some-other-parent",
                parentToolCallId: "tcX",
                depth: 1,
            },
        });

        const subs = listSubagents(await ws.repo.list({ cwd }), parentId);
        assert.equal(subs.length, 2);
        assert.deepEqual(subs.map((s) => s.agentType).sort(), ["coder", "explorer"]);
        assert.deepEqual(subs.map((s) => s.parentToolCallId).sort(), ["tc1", "tc2"]);
    });
});
