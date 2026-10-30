// Consolidated from the per-scenario agentSpawner.*.test.ts files to share one
// tsx process (each file previously paid its own startup cost).

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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition, SubagentSpawnContext } from "../../src/agents/types.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { MAIN_BRANCH } from "../../src/runtime/session/sessionBranch.ts";
import {
    readSessionFacts,
    type SessionFacts,
    writeSessionFacts,
} from "../../src/runtime/session/sessionFacts.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import { readPendingSubagentResults } from "../../src/runtime/subagent/subagentPending.ts";
import { subagentResultPath } from "../../src/runtime/subagent/subagentResultsDir.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createAgentTool } from "../../src/tools/agent.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

/** Escape a filesystem path for literal use inside a RegExp. */
function escapeRegExpBackground(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const defsBackground: AgentDefinition[] = [
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
    let cleanup: () => Promise<void>;

    before(() => {
        ({ ws, cwd, sessionsRoot, cleanup } = createTestWorkspace({
            prefix: "bg",
            agents: defsBackground,
        }));
    });

    after(() => cleanup());

    async function seedSessionBackground(id: string): Promise<void> {
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
            await seedSessionBackground(parent);
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
            // The receipt names the result file before it exists, so a lost
            // completion notice does not strand the result: the model can read
            // the path itself, and ENOENT is the "still running" answer.
            assert.equal(
                res.resultPath,
                subagentResultPath(
                    asSessionId(parent),
                    asSessionId(res.subSessionId ?? ""),
                    sessionsRoot,
                ),
            );
        } finally {
            resolveRun?.();
            // Drain before returning: the settle sequence outlives the call that
            // launched it, and a later test that swaps `getAttached` would
            // otherwise receive this spawn's notice as if it were its own.
            await ws.agentSpawner.whenBackgroundRunsSettle();
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
            await seedSessionBackground(parent);
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
            await ws.agentSpawner.whenBackgroundRunsSettle();
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
            assert.match(notification, new RegExp(escapeRegExpBackground(path)));
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
            await seedSessionBackground(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-empty",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await ws.agentSpawner.whenBackgroundRunsSettle();
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
            await seedSessionBackground(parent);
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
            await seedSessionBackground(parent);
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

    // Delivery needs the parent's live AttachedSession, and there are normal
    // states where that route is closed (parent mid-compaction, process
    // restarted). The notice is recorded before the attempt and cleared only
    // once it lands, so a failed delivery leaves a record to retry from.
    // Also covers the fix for the outer .catch previously treating any
    // deliverSubagentResult throw as "the run failed": outcome/resultPath/
    // description here can only come from the .then branch's own
    // recordPending — the outer .catch's fallback always writes outcome
    // "error" with no resultPath, so seeing "completed" + a real path proves
    // delivery failures no longer fall through to that fallback.
    it("keeps a pending record when delivery fails, and clears it when it succeeds", async () => {
        const registry = ws.sessionRegistry as unknown as {
            getAttached: (id: unknown) => unknown;
        };
        const originalGetAttached = registry.getAttached;
        // Reject as a non-busy error so deliverSubagentResult propagates rather
        // than falling back to the followUp queue.
        registry.getAttached = () => ({
            prompt: async () => {
                throw new Error("parent unreachable");
            },
        });
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "stranded answer",
            isError: false,
        }));
        const parent = "bg-parent-pending";
        try {
            await seedSessionBackground(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-pending",
                agentType: "explorer",
                prompt: "do something",
                description: "scan packages tree",
                background: true,
            });
            await ws.agentSpawner.whenBackgroundRunsSettle();
            const pending = await ws.sessionRegistry.withSession(asSessionId(parent), (s) =>
                readPendingSubagentResults(s),
            );
            assert.deepEqual(Object.keys(pending), ["tc-pending"]);
            assert.equal(pending["tc-pending"]?.outcome, "completed");
            assert.ok(pending["tc-pending"]?.resultPath, "pending record must point at the file");
            assert.equal(pending["tc-pending"]?.description, "scan packages tree");
        } finally {
            registry.getAttached = originalGetAttached;
            restoreExecute();
        }

        // Now the parent is reachable again: attaching flushes the backlog.
        let delivered: string | undefined;
        registry.getAttached = () => ({
            prompt: async (text: string) => {
                delivered = text;
            },
        });
        try {
            await (
                ws.agentSpawner as unknown as {
                    flushPendingSubagentResults: (id: unknown) => Promise<void>;
                }
            ).flushPendingSubagentResults(asSessionId(parent));
            assert.ok(delivered, "flush must re-deliver the stranded notice");
            assert.match(delivered ?? "", /late="true"/);
            assert.match(delivered ?? "", /This notice is late/);
            // A late notice must still say what the subagent was for: by now the
            // conversation has moved on, and compaction may have collapsed the
            // tool call that would otherwise identify it.
            assert.match(delivered ?? "", /Its task was: scan packages tree/);
            const after = await ws.sessionRegistry.withSession(asSessionId(parent), (s) =>
                readPendingSubagentResults(s),
            );
            assert.deepEqual(after, {}, "a delivered notice must not be flushed twice");
        } finally {
            registry.getAttached = originalGetAttached;
        }
    });

    // The outer .catch still has a real job: a failure *before* the .then
    // branch could make its own pending record (here, a "subagent.settled"
    // listener throwing synchronously inside emitSettled's `this.emit`) must
    // still leave a retryable record — just this time with the fallback's
    // outcome "error" and no resultPath, since there is no successful run to
    // report.
    it("falls back to an error record when settling itself throws before recordPending runs", async () => {
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "would have been the answer",
            isError: false,
        }));
        const parent = "bg-parent-settle-throws";
        const boom = new Error("listener exploded");
        const onSettled = () => {
            throw boom;
        };
        ws.agentSpawner.on("subagent.settled", onSettled);
        try {
            await seedSessionBackground(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-settle-throws",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await ws.agentSpawner.whenBackgroundRunsSettle();
            const pending = await ws.sessionRegistry.withSession(asSessionId(parent), (s) =>
                readPendingSubagentResults(s),
            );
            assert.equal(pending["tc-settle-throws"]?.outcome, "error");
            assert.equal(
                pending["tc-settle-throws"]?.resultPath,
                undefined,
                "the fallback record has no file to point at — the run's own result never reached writeBackgroundResult",
            );
        } finally {
            ws.agentSpawner.off("subagent.settled", onSettled);
            restoreExecute();
        }
    });

    it("abortSubagentRun stops a background run and settles it with outcome aborted", async () => {
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
        // The stub settles only when the signal fires — the same shape the
        // real runner has now that it listens for the abort signal.
        const restoreExecute = stubExecute(
            (args) =>
                new Promise((resolve) => {
                    args.signal?.addEventListener("abort", () => {
                        resolve({
                            subSessionId: args.childSessionId ?? asSessionId("unused"),
                            resultText: "Subagent was stopped before it finished.",
                            isError: true,
                        });
                    });
                }),
        );
        try {
            const parent = "bg-parent-abort";
            await seedSessionBackground(parent);
            const res = await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-bg-abort",
                agentType: "explorer",
                prompt: "do something slow",
                background: true,
            });
            const subId = res.subSessionId ?? "";
            assert.ok(subId, "receipt must carry the child session id");
            // Scoped to the owning parent: another session must not stop it.
            assert.equal(
                ws.agentSpawner.abortSubagentRun(subId, asSessionId("someone-else")),
                false,
            );
            assert.equal(ws.agentSpawner.abortSubagentRun(subId, asSessionId(parent)), true);
            await ws.agentSpawner.whenBackgroundRunsSettle();
            assert.match(delivered ?? "", /outcome="aborted"/);
            assert.match(delivered ?? "", /stopped deliberately/);
            // Once settled there is nothing left to stop.
            assert.equal(ws.agentSpawner.abortSubagentRun(subId), false);
        } finally {
            registry.getAttached = originalGetAttached;
            restoreExecute();
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
                ...defsBackground[0],
                agentType: "fast-timeout",
                timeoutMinutes: 10,
            },
        ];
        (ws.agentSpawner as unknown as { agents: AgentDefinition[] }).agents.push(...timeoutDefs);
        const parent = "bg-parent-4";
        await seedSessionBackground(parent);
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
            // The abort resolves the stubbed run, so the settle sequence still
            // has to persist and record its result. Restore the real timer
            // first — draining needs it — then wait, so this spawn's bookkeeping
            // does not run against a workspace the `after` hook has torn down.
            await ws.agentSpawner.whenBackgroundRunsSettle();
            restoreExecute();
        }
    });

    // deliverSubagentResult returns `false` (not a throw) when the parent
    // has no live AttachedSession — the normal state for a parent that was
    // never attached in this process. dropPending must not run in that case,
    // or the notice is stranded with no record to retry from.
    it("keeps the pending record when the parent was never attached (no throw, just unreachable)", async () => {
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "an answer nobody is around to receive",
            isError: false,
        }));
        const parent = "bg-parent-never-attached";
        try {
            await seedSessionBackground(parent);
            assert.equal(
                ws.sessionRegistry.getAttached(asSessionId(parent)),
                undefined,
                "this test only means something if the parent truly has no AttachedSession",
            );
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-never-attached",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await ws.agentSpawner.whenBackgroundRunsSettle();
            const pending = await ws.sessionRegistry.withSession(asSessionId(parent), (s) =>
                readPendingSubagentResults(s),
            );
            assert.deepEqual(Object.keys(pending), ["tc-never-attached"]);
            assert.equal(pending["tc-never-attached"]?.outcome, "completed");
        } finally {
            restoreExecute();
        }
    });

    // Up to MAX_CONCURRENT_BACKGROUND_SUBAGENTS children of the same parent
    // can settle within the same tick. End-to-end regression: SessionRegistry
    // .withSession also serializes detached reads for the same session id
    // (see sessionRegistry.ts), so this passing does not by itself prove
    // AgentSpawner.withPendingQueue is pulling weight — see
    // "withPendingQueue serializes two overlapping writers" below for that.
    // This test exists to catch a regression in the full call path, should
    // that other layer's guarantee ever narrow.
    it("keeps both records when two children of the same parent settle concurrently", async () => {
        const registry = ws.sessionRegistry as unknown as {
            getAttached: (id: unknown) => unknown;
        };
        const originalGetAttached = registry.getAttached;
        // Unreachable parent, so both settles fall through to recordPending
        // without either being cleared by a successful delivery.
        registry.getAttached = () => undefined;
        const resolvers: Array<() => void> = [];
        const restoreExecute = stubExecute(
            (args) =>
                new Promise((resolve) => {
                    resolvers.push(() =>
                        resolve({
                            subSessionId: args.childSessionId ?? asSessionId("unused"),
                            resultText: `answer for ${args.parentToolCallId}`,
                            isError: false,
                        }),
                    );
                }),
        );
        const parent = "bg-parent-concurrent";
        try {
            await seedSessionBackground(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-concurrent-1",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-concurrent-2",
                agentType: "explorer",
                prompt: "do something else",
                background: true,
            });
            // Resolve both stubbed runs in the same tick so their settle
            // sequences' recordPending calls actually overlap.
            for (const resolve of resolvers) resolve();
            await ws.agentSpawner.whenBackgroundRunsSettle();
            const pending = await ws.sessionRegistry.withSession(asSessionId(parent), (s) =>
                readPendingSubagentResults(s),
            );
            assert.deepEqual(
                new Set(Object.keys(pending)),
                new Set(["tc-concurrent-1", "tc-concurrent-2"]),
                "both concurrent settles must leave their own pending record",
            );
        } finally {
            registry.getAttached = originalGetAttached;
            restoreExecute();
        }
    });

    it("withPendingQueue serializes two overlapping writers for the same parent", async () => {
        const spawner = ws.agentSpawner as unknown as {
            withPendingQueue: <T>(parentSessionId: SessionId, run: () => Promise<T>) => Promise<T>;
        };
        const parent = asSessionId("bg-parent-queue-unit");
        const order: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const first = spawner.withPendingQueue(parent, async () => {
            order.push("first-start");
            await new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            order.push("first-end");
        });
        const second = spawner.withPendingQueue(parent, async () => {
            order.push("second-start");
        });
        // Give the second call every chance to run before the first
        // releases — if the queue were a no-op, "second-start" would land
        // between "first-start" and "first-end".
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(order, ["first-start"], "second must not start before first finishes");
        releaseFirst?.();
        await Promise.all([first, second]);
        assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
    });

    // settledEmitted exists only to dedupe the .then/.catch double-emit for
    // one spawn's own settle sequence; retaining entries past that would
    // grow this set by one string per background spawn for the process's
    // entire lifetime.
    it("removes the parentToolCallId from settledEmitted once its settle sequence ends", async () => {
        const restoreExecute = stubExecute(async (args) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText: "done",
            isError: false,
        }));
        const parent = "bg-parent-settled-emitted-cleanup";
        try {
            await seedSessionBackground(parent);
            await ws.agentSpawner.spawnSubagent({
                parentSessionId: asSessionId(parent),
                parentToolCallId: "tc-cleanup",
                agentType: "explorer",
                prompt: "do something",
                background: true,
            });
            await ws.agentSpawner.whenBackgroundRunsSettle();
            const settledEmitted = (ws.agentSpawner as unknown as { settledEmitted: Set<string> })
                .settledEmitted;
            assert.equal(
                settledEmitted.has("tc-cleanup"),
                false,
                "entry must be removed once the settle chain's .finally runs",
            );
        } finally {
            restoreExecute();
        }
    });
});

/**
 * AgentSpawner with a `runtime: claude-code` agent, end to end through the
 * real session repo. The SDK is faked; no CLI or network.
 */

const defsClaudeCode: AgentDefinition[] = [
    {
        agentType: "cc",
        description: "claude code reader",
        systemPrompt: "you read",
        maxTurns: 7,
        runtime: "claude-code",
        source: "user",
        filePath: "/x/cc.md",
    },
];

type Frames = (options: SdkQueryOptions) => AsyncIterable<SdkMessage>;

async function* readThenAnswer(): AsyncIterable<SdkMessage> {
    yield { type: "system", subtype: "init" };
    yield {
        type: "assistant",
        message: {
            id: "a1",
            content: [
                { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
            ],
        },
    };
    yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }] },
    };
    yield {
        type: "assistant",
        message: { id: "a2", content: [{ type: "text", text: "It says hello." }] },
    };
    yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "It says hello.",
        num_turns: 2,
    };
}

describe("AgentSpawner — runtime: claude-code", () => {
    let cwd: string;
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;
    let frames: Frames = readThenAnswer;
    let lastOptions: SdkQueryOptions | undefined;

    before(() => {
        ({ ws, cwd, cleanup } = createTestWorkspace({
            prefix: "cc",
            agents: defsClaudeCode,
        }));
        const sdk: ClaudeAgentSdk = {
            query({ options }) {
                lastOptions = options;
                return frames(options);
            },
        };
        const spawner = ws.agentSpawner as unknown as {
            loadClaudeCodeSdk: () => Promise<ClaudeAgentSdk>;
            findClaudeCode: () => string | undefined;
        };
        spawner.loadClaudeCodeSdk = async () => sdk;
        spawner.findClaudeCode = () => "/usr/local/bin/claude";
    });

    after(() => cleanup());

    async function seedParent(): Promise<SessionId> {
        const id = asSessionId(`parent-${Math.random().toString(36).slice(2)}`);
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
        return id;
    }

    /** Parent with one message — fork renders nothing from an empty branch. */
    async function seedParentWithMessage(): Promise<SessionId> {
        const id = asSessionId(`parent-${Math.random().toString(36).slice(2)}`);
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        const branch = await session.createBranch("main", null, harnessContext);
        await branch.appendMessage(
            { role: "user", content: "earlier context", timestamp: Date.now() },
            harnessContext,
        );
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
        return id;
    }

    it("runs synchronously, returns the answer, and persists a readable transcript", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const r = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-1",
            agentType: "cc",
            prompt: "what does the readme say",
        });
        assert.equal(r.isError, false, r.resultText);
        assert.equal(r.resultText, "It says hello.");
        assert.ok(r.subSessionId);
        assert.equal(lastOptions?.cwd, cwd);
        assert.equal(lastOptions?.maxTurns, 7);
        assert.equal(lastOptions?.systemPrompt.append, "you read");

        const hist = await ws.getHistory(r.subSessionId);
        const roles = hist.entries.map((e) => (e as { message?: { role?: string } }).message?.role);
        assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);

        const facts = await ws.sessionRegistry.withSession(r.subSessionId, (s) =>
            readSessionFacts(s),
        );
        assert.equal(facts.runtime, "claude-code");
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.parentSessionId, parent);
    });

    it("publishes a started update carrying subSessionId, so the card is clickable while running", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const updates: Array<Record<string, unknown>> = [];
        await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-live",
            agentType: "cc",
            prompt: "x",
            onUpdate: (payload) => {
                updates.push(payload as unknown as Record<string, unknown>);
            },
        });
        const started = updates[0];
        assert.ok(started, "no progress update was published");
        const startedDetails = started.details as { subSessionId?: string; agentType?: string };
        assert.equal(startedDetails.agentType, "cc");
        assert.ok(startedDetails.subSessionId, "started update carried no subSessionId");
        // Every update carries the id — that is what makes a running card openable.
        for (const u of updates) {
            assert.ok(
                (u.details as { subSessionId?: string })?.subSessionId,
                `update without subSessionId: ${JSON.stringify(u)}`,
            );
        }
    });

    it("streams child messages as pi-style events so the panel updates live", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const events: Array<{ type: string; toolCallId?: string; toolName?: string }> = [];
        ws.on("session.event", (e: { sessionId: string; event: Record<string, unknown> }) => {
            if (e.sessionId !== undefined && e.sessionId !== parent) {
                events.push({
                    type: e.event.type as string,
                    toolCallId: e.event.toolCallId as string | undefined,
                    toolName: e.event.toolName as string | undefined,
                });
            }
        });
        await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-live",
            agentType: "cc",
            prompt: "x",
        });
        const kinds = events.map((e) => e.type);
        // pi's order: every assistant message opens its bubble before its tool
        // calls arrive. The desktop attaches tool events to the last bubble, so
        // a tool_start ahead of message_start renders as a fallback text row
        // ("▶ Read" / "✓ Read: …") instead of a card.
        assert.deepEqual(kinds, [
            "message_end", // user prompt
            "message_start", // assistant: tool call
            "message_end",
            "tool_start",
            "tool_end", // its result fills the card
            "message_start", // assistant: final reply
            "message_end",
        ]);
        assert.equal(events[3]?.toolName, "Read");
        assert.equal(events[4]?.toolName, "Read");
    });

    it("stops through abortSubagentRun, like a pi subagent", async () => {
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        frames = (options) =>
            (async function* () {
                started();
                await new Promise<void>((resolve) =>
                    options.abortController.signal.addEventListener("abort", () => resolve(), {
                        once: true,
                    }),
                );
                throw new Error("Claude Code process aborted by user");
            })();
        const parent = await seedParent();
        let childId: string | undefined;
        ws.agentSpawner.once("subagent.spawned", (e: { subSessionId: string }) => {
            childId = e.subSessionId;
        });
        const pending = ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-2",
            agentType: "cc",
            prompt: "wait",
        });
        await running;
        assert.ok(childId);
        assert.equal(ws.agentSpawner.abortSubagentRun(childId, parent), true);
        const r = await pending;
        assert.equal(r.isError, true);
        assert.match(r.resultText, /deliberate interruption/);
        assert.equal(ws.agentSpawner.abortSubagentRun(childId, parent), false);
    });

    it("runs in the background and settles through the shared completion path", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const settled = new Promise<{ outcome: string; subSessionId: string }>((resolve) => {
            ws.agentSpawner.once("subagent.settled", resolve);
        });
        const receipt = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-bg",
            agentType: "cc",
            prompt: "x",
            background: true,
        });
        assert.equal(receipt.isError, false, receipt.resultText);
        assert.equal(receipt.background, true);
        assert.ok(receipt.resultPath);
        const s = await settled;
        assert.equal(s.outcome, "completed");
        assert.equal(s.subSessionId, receipt.subSessionId);
        await ws.agentSpawner.whenBackgroundRunsSettle();
        assert.equal(await readFile(receipt.resultPath, "utf-8"), "It says hello.");
    });

    it("corrects context: fork to independent instead of failing", async () => {
        // The model cannot pass a runtime, so it may ask a claude-code agent
        // for fork context it cannot have. Correcting it is friendlier than an
        // error — the spawner already decided the mode before creating the
        // child, so nothing is lost.
        frames = readThenAnswer;
        const parent = await seedParentWithMessage();
        const r = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-3",
            agentType: "cc",
            prompt: "x",
            context: "fork",
        });
        assert.equal(r.isError, false, r.resultText);
        assert.ok(r.subSessionId);
        // The real assertion: the fork block never ran. Asserting only on
        // success would pass either way — the claude-code runner ignores
        // `forkedContext`, so a missing downgrade is invisible to the result.
        // It is still wrong: it renders the whole parent transcript and
        // persists it into the child's facts for a child that cannot use it.
        const facts = await ws.sessionRegistry.withSession(r.subSessionId, (sess) =>
            readSessionFacts(sess),
        );
        assert.equal(facts.forkedContext, undefined);
    });

    it("refuses agentContinue on a claude-code child", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const first = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-4",
            agentType: "cc",
            prompt: "x",
        });
        assert.ok(first.subSessionId);
        const r = await ws.agentSpawner.resumeSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-5",
            subSessionId: first.subSessionId,
            prompt: "more",
        });
        assert.equal(r.isError, true);
        assert.match(r.resultText, /cannot be resumed/);
    });

    describe("fixed run directory", () => {
        let fixedDir: string;
        before(() => {
            fixedDir = mkdtempSync(join(tmpdir(), "taco-cc-fixed-"));
        });
        after(() => rmSync(fixedDir, { recursive: true, force: true }));

        function withCwd(cwdValue: string | undefined): () => void {
            const original = ws.agentSpawner.agents;
            ws.agentSpawner.replaceAgents(
                original.map((a) =>
                    a.agentType === "cc" ? { ...a, ...(cwdValue ? { cwd: cwdValue } : {}) } : a,
                ),
            );
            return () => ws.agentSpawner.replaceAgents(original);
        }

        it("runs in the directory fixed in the definition", async () => {
            frames = readThenAnswer;
            const restore = withCwd(fixedDir);
            try {
                const r = await ws.agentSpawner.spawnSubagent({
                    parentSessionId: await seedParent(),
                    parentToolCallId: "call-fixed-1",
                    agentType: "cc",
                    prompt: "x",
                });
                assert.equal(r.isError, false, r.resultText);
                assert.equal(lastOptions?.cwd, fixedDir);
            } finally {
                restore();
            }
        });

        it("fails without starting the CLI when the fixed directory is gone", async () => {
            frames = readThenAnswer;
            const restore = withCwd(join(fixedDir, "missing"));
            lastOptions = undefined;
            try {
                const r = await ws.agentSpawner.spawnSubagent({
                    parentSessionId: await seedParent(),
                    parentToolCallId: "call-fixed-2",
                    agentType: "cc",
                    prompt: "x",
                });
                assert.equal(r.isError, true);
                assert.match(r.resultText, /not an existing directory/);
                assert.equal(lastOptions, undefined);
            } finally {
                restore();
            }
        });

        it("a definition without a directory falls back to the workspace", async () => {
            frames = readThenAnswer;
            const restore = withCwd(undefined);
            try {
                const r = await ws.agentSpawner.spawnSubagent({
                    parentSessionId: await seedParent(),
                    parentToolCallId: "call-fixed-3",
                    agentType: "cc",
                    prompt: "x",
                });
                assert.equal(r.isError, false, r.resultText);
                assert.equal(lastOptions?.cwd, cwd);
            } finally {
                restore();
            }
        });
    });
});

// Reload path used by agents.write/delete: the workspace swaps the catalog
// into the spawner and rebuilds <available_agents> only when it changed.
describe("WorkspaceRuntime.reloadAgentsNow", () => {
    let ws2: WorkspaceRuntime;
    let cleanup2: () => Promise<void>;
    before(() => {
        ({ ws: ws2, cleanup: cleanup2 } = createTestWorkspace({
            prefix: "cc-reload",
            agents: defsClaudeCode,
        }));
    });
    after(() => cleanup2());

    it("keeps the runtime out of everything the model sees", () => {
        // The model delegates by agent name only; the spawner picks the engine.
        const prompt = ws2.systemPrompt;
        assert.ok(prompt.includes("<name>cc</name>"));
        assert.ok(!/claude-code|runtime/i.test(prompt.slice(prompt.indexOf("<available_agents>"))));
        const agentTool = createAgentTool({} as SubagentSpawnContext, []);
        const schema = JSON.stringify(agentTool.parameters);
        assert.ok(!/runtime|claude-code/i.test(schema), schema);
    });

    it("makes a newly written claude-code agent spawnable without a rebuild", () => {
        const added: AgentDefinition = {
            agentType: "cc2",
            description: "second",
            systemPrompt: "you read more",
            runtime: "claude-code",
            source: "user",
            filePath: "/x/cc2.md",
        };
        const promptBefore = ws2.agentSpawner.findAgent("cc2");
        assert.equal(promptBefore, undefined);
        ws2.reloadAgentsNow([...defsClaudeCode, added]);
        assert.equal(ws2.agentSpawner.findAgent("cc2")?.runtime, "claude-code");
        assert.ok(ws2.systemPrompt.includes("cc2"));
    });
});

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

const defsInstructions: AgentDefinition[] = [
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
    let ws: WorkspaceRuntime;
    /** System prompts handed to attachChild, in call order. */
    let captured: string[];
    let cleanup: () => Promise<void>;

    before(async () => {
        ({ ws, cwd, cleanup } = createTestWorkspace({
            prefix: "instr",
            agents: defsInstructions,
            setup: (dir) => writeFileSync(join(dir, "CLAUDE.md"), CLAUDE_MD),
        }));
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
        // Release pi's open-session slot before returning. `repo.create()` returns a
        // session whose handle owns that slot until `close()` is called; if we
        // let it leak, the first `spawnSubagent` call would re-open `parent-1`
        // and throw "Session is already open" because two handles would race
        // for the same id. The release must happen here, not in `after`, so
        // the slot is free during every test body.
        await ws.repo
            .create({ id: "parent-1", cwd }, harnessContext)
            .then((s) => s.close(harnessContext));
    });

    after(() => cleanup());

    async function spawnAndCaptureInstructions(toolCallId: string): Promise<string> {
        const res = await ws.spawnSubagent({
            parentSessionId: asSessionId("parent-1"),
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
        assert.match(await spawnAndCaptureInstructions("tc-before"), /always use tabs/);
    });

    it("drops the block from the next spawn after instructions are disabled", async () => {
        ws.updateInstructionsConfig({ enabled: false });
        assert.equal(ws.parentInstructionsBlock, "");
        const prompt = await spawnAndCaptureInstructions("tc-after-disable");
        assert.doesNotMatch(
            prompt,
            /always use tabs/,
            "child must not inherit a block the parent has dropped",
        );
    });

    it("re-adds the block when instructions are turned back on", async () => {
        ws.updateInstructionsConfig(undefined);
        assert.match(ws.parentInstructionsBlock, /always use tabs/);
        assert.match(await spawnAndCaptureInstructions("tc-after-reenable"), /always use tabs/);
    });
});

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

const defsResume: AgentDefinition[] = [
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
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;

    before(() => {
        ({ ws, cwd, cleanup } = createTestWorkspace({ prefix: "resume", agents: defsResume }));
    });

    after(() => cleanup());

    /**
     * Create a session on disk, optionally stamping the sidecar's facts on it.
     *
     * Two 0.85 constraints are baked in here. `repo.create()` no longer takes a
     * free-form `metadata` bag — subagent attributes are session values written
     * after creation — and the session it returns is *open*, so it must be
     * closed or the later openSession/attach of the same id is rejected.
     */
    async function seedSessionResume(id: string, facts?: SessionFacts): Promise<void> {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        try {
            if (facts) await writeSessionFacts(session, facts);
        } finally {
            await session.close(harnessContext);
        }
    }

    it("returns isError when the subSessionId does not exist", async () => {
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId("does-not-matter"),
            parentToolCallId: "tc",
            subSessionId: asSessionId("ghost-session"),
            prompt: "follow up",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /session not found: ghost-session/);
    });

    it("returns isError when the target session is not a subagent", async () => {
        // Create a main session (kind not "subagent"), then try to resume it.
        await seedSessionResume("main-session");
        // `openSession` reads from SessionRegistry's metadata cache; direct
        // repo.create bypasses its invalidation, so flush explicitly.
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId("anything"),
            parentToolCallId: "tc",
            subSessionId: asSessionId("main-session"),
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
        await seedSessionResume(parentA);
        await seedSessionResume(parentB);
        await seedSessionResume("child-of-A", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: parentA,
            parentToolCallId: "tcA",
            depth: 1,
        });
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId(parentB),
            parentToolCallId: "tcB",
            subSessionId: asSessionId("child-of-A"),
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
                parentSessionId: asSessionId("p"),
                parentToolCallId: "tc",
                subSessionId: asSessionId("same-sub"),
                prompt: "1",
            });
            const p2 = ws.agentSpawner.resumeSubagent({
                parentSessionId: asSessionId("p"),
                parentToolCallId: "tc",
                subSessionId: asSessionId("same-sub"),
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
        await seedSessionResume(parent);
        await seedSessionResume("child-defgone", {
            kind: "subagent",
            agentType: "ghost-agent",
            parentSessionId: asSessionId(parent),
            parentToolCallId: "tcD",
            depth: 1,
        });
        ws.sessionRegistry.invalidateListCache();
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId(parent),
            parentToolCallId: "tcD",
            subSessionId: asSessionId("child-defgone"),
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
        await seedSessionResume(parent);
        await seedSessionResume("child-exhausted", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: asSessionId(parent),
            parentToolCallId: "tcE",
            depth: 1,
        });
        ws.sessionRegistry.invalidateListCache();
        // Append enough assistant messages to consume the 10-turn budget.
        // Use the raw repo handle so we don't need to drive a real harness.
        // AssistantMessage requires api/provider/model/usage/stopReason — the
        // counter only reads `role === "assistant"`, so the rest is stubbed.
        const meta = await ws.sessionRegistry.openSession(asSessionId("child-exhausted"));
        const session = await ws.repo.open(meta, harnessContext);
        // 0.85 moved appendMessage from Session onto Branch, and a freshly
        // created session has no branch yet.
        const branch =
            (await session.branch(MAIN_BRANCH, harnessContext)) ??
            (await session.createBranch(MAIN_BRANCH, null, harnessContext));
        for (let i = 0; i < 12; i++) {
            await branch.appendMessage(
                {
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
                },
                harnessContext,
            );
        }
        // Release the handle: resumeSubagent opens the same session itself, and
        // 0.85's repo rejects a second open while the first is live.
        await session.close(harnessContext);
        const res = await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId(parent),
            parentToolCallId: "tcE",
            subSessionId: asSessionId("child-exhausted"),
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
        await seedSessionResume("main-cache-probe");
        ws.sessionRegistry.invalidateListCache();
        const before = map.size;
        await ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId("x"),
            parentToolCallId: "tc",
            subSessionId: asSessionId("main-cache-probe"),
            prompt: "p",
        });
        assert.equal(map.size, before, "resumeInFlight must drain on settle, not retain entries");
    });
});

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

const defsSkill: AgentDefinition[] = [
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
        ({ ws, cleanup } = createTestWorkspace({ prefix: "skill-io", agents: defsSkill }));
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

const defsTools: AgentDefinition[] = [
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
    executionDir: { mode: "shared" },
};
const SHELL_ALLOW_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
    executionDir: { mode: "shared" },
};

describe("AgentSpawner parent-toolset inheritance", () => {
    let cwd: string;
    let ws: WorkspaceRuntime;
    /** Tool name lists handed to attachChild, in call order. */
    let captured: string[][];
    let policy: ImWorkspacePolicy;
    let cleanup: () => Promise<void>;

    before(async () => {
        policy = SHELL_DENY_POLICY;
        ({ ws, cwd, cleanup } = createTestWorkspace({
            prefix: "tools-thunk",
            agents: defsTools,
            resolveImPolicy: () => policy,
        }));
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

    after(() => cleanup());

    async function spawnAndCaptureTools(toolCallId: string): Promise<string[]> {
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
        const names = await spawnAndCaptureTools("tc-before-grant");
        assert.ok(!names.includes("shell"));
    });

    it("a subagent spawned after a per-turn toolset refresh sees the newly granted tool", async () => {
        // Simulate what a real turn does: the policy changes, then the next
        // turn calls refreshToolset() (here invoked directly, standing in for
        // the per-turn call AttachedSession.applyToolsetRefresh makes).
        policy = SHELL_ALLOW_POLICY;
        const refreshed = ws.refreshToolset(
            "parent-1" as never,
            { taskStore: undefined, tasksDir: cwd, planState: undefined } as never,
        );
        assert.ok(
            refreshed.some((t) => t.name === "shell"),
            "policy flip must reach the assembly",
        );

        const names = await spawnAndCaptureTools("tc-after-grant");
        assert.ok(
            names.includes("shell"),
            `subagent must see the tool granted to the parent, got: ${names.join(", ")}`,
        );
    });
});
