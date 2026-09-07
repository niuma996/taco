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
import type { SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { type SessionFacts, writeSessionFacts } from "../../src/runtime/sessionFacts.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

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

    /**
     * Create a session, optionally stamping the sidecar's facts on it.
     *
     * `repo.create()` returns an *open* session and 0.85's repo rejects a
     * second open of the same id, so the handle is released before returning.
     */
    async function seedSession(id: string, facts?: SessionFacts): Promise<void> {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        try {
            if (facts) await writeSessionFacts(session, facts);
        } finally {
            await session.close(harnessContext);
        }
        // openSession resolves through SessionRegistry's metadata cache; a
        // direct repo.create bypasses its invalidation.
        ws.sessionRegistry.invalidateListCache();
    }

    /**
     * Subagent row filter (reader-end contract): keep sessions whose facts say
     * `kind === "subagent"` with a matching parent, then project the fields the
     * agent list surfaces.
     *
     * Reads facts per session rather than a metadata bag — pi 0.85 fixed the
     * metadata shape, so these attributes live in each session's value store
     * and cost one read apiece.
     */
    async function listSubagents(
        ids: readonly string[],
        parentSessionId: string,
    ): Promise<Array<{ sessionId: string; agentType: string; parentToolCallId: string }>> {
        const out: Array<{ sessionId: string; agentType: string; parentToolCallId: string }> = [];
        for (const id of ids) {
            const facts = await ws.getSessionFacts(id as SessionId);
            if (facts.kind !== "subagent" || facts.parentSessionId !== parentSessionId) continue;
            out.push({
                sessionId: id,
                agentType: String(facts.agentType),
                parentToolCallId: String(facts.parentToolCallId),
            });
        }
        return out;
    }

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
        await seedSession("parent-1");
        const subs = await listSubagents(["parent-1"], "parent-1");
        assert.deepEqual(subs, []);
    });

    it("subagent facts persisted at spawn are filtered to the matching parent", async () => {
        // Write facts directly, mirroring what spawnSubagent persists. Validates
        // the reader-side filter + mapping logic (no LLM needed).
        const parentId = "parent-2";
        await seedSession(parentId);
        await seedSession("child-a", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: parentId,
            parentToolCallId: "tc1",
            depth: 1,
        });
        await seedSession("child-b", {
            kind: "subagent",
            agentType: "coder",
            parentSessionId: parentId,
            parentToolCallId: "tc2",
            depth: 1,
        });
        // Subagent for a different parent — must not be mixed in
        await seedSession("child-other", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: "some-other-parent",
            parentToolCallId: "tcX",
            depth: 1,
        });

        const subs = await listSubagents(
            ["parent-2", "child-a", "child-b", "child-other"],
            parentId,
        );
        assert.equal(subs.length, 2);
        assert.deepEqual(subs.map((s) => s.agentType).sort(), ["coder", "explorer"]);
        assert.deepEqual(subs.map((s) => s.parentToolCallId).sort(), ["tc1", "tc2"]);
    });
});
