/**
 * AgentSpawner.resumeSubagent — tests the validation paths that do not need
 * a real LLM harness.
 *
 * Covered:
 *  - missing subagent session id → error (openSession throws)
 *  - target session is not a subagent (kind !== "subagent") → error
 *  - parentSessionId mismatch → error (cross-parent isolation)
 *  - single-flight: concurrent resumeSubagent on the same subSessionId shares
 *    one in-flight promise
 *
 * Not covered here (require a real harness with model): the happy-path run
 * against an attached child session. The narrow validation branches are the
 * ones most likely to regress silently — the happy path is exercised by the
 * end-to-end subagent smoke tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

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

describe("AgentSpawner.resumeSubagent — validation", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;

    before(() => {
        cwd = mkdtempSync(join(tmpdir(), "taco-ws-resume-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sessions-resume-"));
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

    it("returns isError when the subSessionId does not exist", async () => {
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: "does-not-matter",
            parentToolCallId: "tc",
            subSessionId: "ghost-session",
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /session not found: ghost-session/);
    });

    it("returns isError when the target session is not a subagent", async () => {
        // Create a main session (kind not "subagent"), then try to resume it.
        await ws.repo.create({ id: "main-session", cwd });
        // `openSession` reads from SessionRegistry's metadata cache; direct
        // repo.create bypasses its invalidation, so flush explicitly.
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: "anything",
            parentToolCallId: "tc",
            subSessionId: "main-session",
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /is not a subagent/);
    });

    it("rejects cross-parent resume — only the original parent may continue", async () => {
        // Two real parents, the subagent belongs to parent-A. parent-B must not
        // be able to reach into it (the implicit same-conversation contract).
        const parentA = "parent-A";
        const parentB = "parent-B";
        await ws.repo.create({ id: parentA, cwd });
        await ws.repo.create({ id: parentB, cwd });
        await ws.repo.create({
            id: "child-of-A",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "explorer",
                parentSessionId: parentA,
                parentToolCallId: "tcA",
                depth: 1,
            },
        });
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: parentB,
            parentToolCallId: "tcB",
            subSessionId: "child-of-A",
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /different parent session/);
    });

    it("single-flight: concurrent resumeSubagent on same subSessionId share one in-flight promise", async () => {
        // Stub out `runResume` to a slow promise, then fire two concurrent
        // calls against the same subSessionId. If single-flight works, both
        // callers receive the SAME in-flight Promise (so they observe the
        // single result and the cache entry is created exactly once). We probe
        // via a counter the stub increments — if the cache didn't share, the
        // counter would be 2.
        let runResumeCalls = 0;
        const originalRunResume = (
            ws.agentSpawner as unknown as {
                runResume: (args: unknown) => Promise<{
                    subSessionId: string;
                    resultText: string;
                    isError: boolean;
                }>;
            }
        ).runResume;
        (
            ws.agentSpawner as unknown as { runResume: (args: unknown) => Promise<unknown> }
        ).runResume = async () => {
            runResumeCalls++;
            // Deliberately slow so both concurrent calls land before settle.
            await new Promise((r) => setTimeout(r, 20));
            return { subSessionId: "s", resultText: "shared", isError: false };
        };
        try {
            const p1 = ws.agentSpawner.resumeSubagent({
                parentSessionId: "p",
                parentToolCallId: "tc",
                subSessionId: "same-sub",
                prompt: "1",
            });
            const p2 = ws.agentSpawner.resumeSubagent({
                parentSessionId: "p",
                parentToolCallId: "tc",
                subSessionId: "same-sub",
                prompt: "2",
            });
            const [r1, r2] = await Promise.all([p1, p2]);
            assert.equal(runResumeCalls, 1, "single-flight must reuse the same in-flight run");
            assert.equal(r1.resultText, "shared");
            assert.equal(r2.resultText, "shared");
        } finally {
            (
                ws.agentSpawner as unknown as {
                    runResume: typeof originalRunResume;
                }
            ).runResume = originalRunResume;
        }
    });

    it("rejects when the original agent definition is gone (fail-closed, no permission upgrade)", async () => {
        // Spawn path registered the subagent under "explorer". If the explorer
        // profile is later removed from the agents registry, resumeSubagent
        // must NOT silently widen the toolset to the parent's full set —
        // a read-only explorer becoming a write-capable agent is a privilege
        // escalation. Fail closed instead.
        const parent = "parent-defgone";
        await ws.repo.create({ id: parent, cwd });
        await ws.repo.create({
            id: "child-defgone",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "ghost-agent",
                parentSessionId: parent,
                parentToolCallId: "tcD",
                depth: 1,
            },
        });
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: parent,
            parentToolCallId: "tcD",
            subSessionId: "child-defgone",
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /agent definition for "ghost-agent" is no longer available/);
    });

    it("fails fast when the subagent already exhausted its turn budget", async () => {
        // The subagent metadata says maxTurns=10 on the explorer def, but the
        // branch already has >= 10 assistant messages. countAssistantTurns
        // reads getBranch(), and the subtraction must clamp to fail-fast
        // rather than burn one more LLM round to discover the cap.
        const parent = "parent-exhausted";
        await ws.repo.create({ id: parent, cwd });
        await ws.repo.create({
            id: "child-exhausted",
            cwd,
            metadata: {
                kind: "subagent",
                agentType: "explorer",
                parentSessionId: parent,
                parentToolCallId: "tcE",
                depth: 1,
            },
        });
        ws.sessionRegistry.invalidateListCache();
        // Append enough assistant messages to consume the 10-turn budget.
        // Use the raw repo handle so we don't need to drive a real harness.
        // AssistantMessage requires api/provider/model/usage/stopReason — the
        // counter only reads `role === "assistant"`, so the rest is stubbed.
        const meta = await ws.sessionRegistry.openSession("child-exhausted");
        const session = await ws.repo.open(meta);
        for (let i = 0; i < 12; i++) {
            await session.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: `turn ${i}` }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "claude-opus-4-8",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });
        }
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: parent,
            parentToolCallId: "tcE",
            subSessionId: "child-exhausted",
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /exhausted its 10-turn budget/);
    });

    it("single-flight: in-flight map entry is removed after promise settles", async () => {
        // Probe the internal `resumeInFlight` Map via a deliberate pass: wrap
        // resumeSubagent so we can observe the cache state around an await.
        // We use the "not a subagent" path to get a fast, deterministic
        // rejection; the assertion is about cache hygiene, not the error.
        const map = (
            ws.agentSpawner as unknown as {
                resumeInFlight: Map<string, unknown>;
            }
        ).resumeInFlight;
        await ws.repo.create({ id: "main-cache-probe", cwd });
        ws.sessionRegistry.invalidateListCache();
        const before = map.size;
        await ws.agentSpawner.resumeSubagent({
            parentSessionId: "x",
            parentToolCallId: "tc",
            subSessionId: "main-cache-probe",
            prompt: "p",
        });
        assert.equal(map.size, before, "resumeInFlight must drain on settle, not retain entries");
    });
});
