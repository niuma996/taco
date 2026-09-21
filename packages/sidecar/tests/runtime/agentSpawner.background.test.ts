/**
 * AgentSpawner.spawnSubagent — `background: true` branch.
 *
 * Covered without a real LLM harness (executeSubagentSession is stubbed, same
 * technique agentSpawner.resume.test.ts uses for runResume):
 *  - immediate return with a session id, before the stubbed run resolves
 *  - the deferred run's result reaches deliverSubagentResult once it settles
 *  - concurrency gate rejects a launch when backgroundInFlight is full,
 *    without creating a child session
 *  - timeout aborts the child's signal once the wall-clock budget elapses
 *
 * Not covered here: the real executeSubagentSession → subagentRunner path
 * (exercised by workspace.subagent.test.ts / subagentRunner.test.ts) and the
 * real deliverSubagentResult sequence (subagentDelivery.test.ts).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId, asWorkspaceId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { subagentResultPath } from "../../src/runtime/subagent/subagentResultsDir.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

/** Escape a filesystem path for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const defs: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "read-only search",
        systemPrompt: "you explore",
        source: "builtin",
        filePath: "/x/explorer.md",
    },
];

type ExecuteSubagentSession = (args: {
    parentSessionId: SessionId;
    parentToolCallId: string;
    childSessionId?: SessionId;
    signal?: AbortSignal;
}) => Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }>;

describe("AgentSpawner.spawnSubagent — background", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;

    before(() => {
        cwd = mkdtempSync(join(tmpdir(), "taco-ws-bg-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sessions-bg-"));
        ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(cwd),
            sessionsRoot,
            agents: defs,
        });
    });

    after(async () => {
        await ws.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    async function seedSession(id: string): Promise<void> {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
    }

    /** Swap `executeSubagentSession` for a controllable stub; returns a restore fn. */
    function stubExecute(impl: ExecuteSubagentSession): () => void {
        const spawner = ws.agentSpawner as unknown as { executeSubagentSession: unknown };
        const original = spawner.executeSubagentSession;
        spawner.executeSubagentSession = impl;
        return () => {
            spawner.executeSubagentSession = original;
        };
    }

    it("returns a launch receipt immediately, before the run settles", async () => {
        let resolveRun: (() => void) | undefined;
        const restore = stubExecute(
            (args) =>
                new Promise((resolve) => {
                    resolveRun = () =>
                        resolve({
                            subSessionId: args.childSessionId ?? asSessionId("unused"),
                            resultText: "done",
                            isError: false,
                        });
                }),
        );
        try {
            const parent = "bg-parent-1";
            await seedSession(parent);
            const res = await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-1",
                agentType: "explorer",
                prompt: "do something slow",
                background: true,
            });
            assert.equal(res.isError, false);
            assert.equal(res.background, true);
            assert.ok(res.subSessionId, "receipt must carry the pre-generated child session id");
            assert.equal(res.resultText, "", "background receipt carries no result text yet");
        } finally {
            resolveRun?.();
            restore();
        }
    });

    it("delivers the deferred result to the parent once the run settles", async () => {
        let delivered: { parentSessionId: unknown; notification: string } | undefined;
        // Spy on getAttached via sessionRegistry so we can observe what
        // deliverSubagentResult would have sent, without a real AttachedSession.
        const registry = ws.sessionRegistry as unknown as {
            getAttached: (id: unknown) => unknown;
        };
        const originalGetAttached = registry.getAttached;
        registry.getAttached = (id: unknown) => {
            return {
                prompt: async (text: string) => {
                    delivered = { parentSessionId: id, notification: text };
                },
            };
        };
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "the subagent's answer",
            isError: false,
        }));
        try {
            const parent = "bg-parent-2";
            await seedSession(parent);
            const res = await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-2",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            assert.equal(res.background, true);
            // The run is fire-and-forget; give the microtask queue a turn to
            // drain the .then() chain down to deliverSubagentResult.
            await new Promise((r) => setTimeout(r, 10));
            assert.ok(delivered, "deliverSubagentResult must be reached once the run settles");
            assert.equal(delivered?.parentSessionId, parent);
            const notification = delivered?.notification ?? "";
            assert.match(notification, /outcome="completed"/);
            // The answer travels on disk, not in the parent's context.
            assert.ok(
                !notification.includes("the subagent's answer"),
                "notification must carry a path, not the result text",
            );
            const path = subagentResultPath(
                asSessionId(parent),
                asSessionId(res.subSessionId ?? ""),
                sessionsRoot,
            );
            assert.match(notification, new RegExp(escapeRegExp(path)));
            assert.equal(await readFile(path, "utf8"), "the subagent's answer");
        } finally {
            registry.getAttached = originalGetAttached;
            restoreExecute();
        }
    });

    it("delivers an error envelope when the deferred run reports isError with empty text", async () => {
        let delivered: string | undefined;
        const registry = ws.sessionRegistry as unknown as {
            getAttached: (id: unknown) => unknown;
        };
        const originalGetAttached = registry.getAttached;
        registry.getAttached = () => ({
            prompt: async (text: string) => {
                delivered = text;
            },
        });
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "",
            isError: true,
        }));
        try {
            const parent = "bg-parent-empty";
            await seedSession(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-empty",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await new Promise((r) => setTimeout(r, 10));
            assert.ok(delivered);
            assert.match(delivered ?? "", /outcome="error"/);
            assert.match(delivered ?? "", /this background task failed/);
        } finally {
            registry.getAttached = originalGetAttached;
            restoreExecute();
        }
    });

    it("rejects a background launch when the concurrency limit is already full", async () => {
        const spawner = ws.agentSpawner as unknown as { backgroundInFlight: Set<string> };
        const filler = Array.from({ length: 8 }, (_, i) => `filler-${i}`);
        for (const id of filler) spawner.backgroundInFlight.add(id);
        try {
            const parent = "bg-parent-3";
            await seedSession(parent);
            const res = await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-3",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            assert.equal(res.isError, true);
            assert.equal(res.background, true);
            assert.match(res.resultText, /too many background subagents/);
            assert.equal(res.subSessionId, undefined, "a rejected launch must not name a session");
        } finally {
            for (const id of filler) spawner.backgroundInFlight.delete(id);
        }
    });

    it("rejects a duplicate background spawn for the same parentToolCallId", async () => {
        const spawner = ws.agentSpawner as unknown as { backgroundInFlight: Set<string> };
        spawner.backgroundInFlight.add("tc-dup");
        try {
            const parent = "bg-parent-dup";
            await seedSession(parent);
            const res = await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-dup",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            assert.equal(res.isError, true);
            assert.equal(res.background, true);
            assert.match(res.resultText, /already running/);
            assert.equal(
                spawner.backgroundInFlight.size,
                1,
                "duplicate must not add a second slot",
            );
        } finally {
            spawner.backgroundInFlight.delete("tc-dup");
        }
    });

    it("aborts the run's signal once the wall-clock timeout elapses", async () => {
        let capturedSignal: AbortSignal | undefined;
        const restoreExecute = stubExecute(
            (args) =>
                new Promise((resolve) => {
                    capturedSignal = args.signal;
                    args.signal?.addEventListener("abort", () => {
                        resolve({
                            subSessionId: args.childSessionId ?? asSessionId("unused"),
                            resultText: "(aborted)",
                            isError: true,
                        });
                    });
                }),
        );
        const timeoutDefs: AgentDefinition[] = [
            {
                ...defs[0],
                agentType: "fast-timeout",
                timeoutMinutes: 10,
            },
        ];
        (ws.agentSpawner as unknown as { agents: AgentDefinition[] }).agents.push(...timeoutDefs);
        const parent = "bg-parent-4";
        await seedSession(parent);
        const originalSetTimeout = globalThis.setTimeout;
        let fireTimeout: (() => void) | undefined;
        globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
            fireTimeout = fn;
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        try {
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-4",
                agentType: "fast-timeout",
                prompt: "do something slow",
                background: true,
            });
            assert.ok(capturedSignal, "background spawn must pass its own AbortSignal");
            assert.ok(fireTimeout, "background spawn must arm a timeout");
            fireTimeout();
            assert.equal(capturedSignal?.aborted, true, "timeout must abort the background signal");
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            restoreExecute();
        }
    });
});
