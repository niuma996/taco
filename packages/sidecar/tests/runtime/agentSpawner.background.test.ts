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
import { readPendingSubagentResults } from "../../src/runtime/subagent/subagentPending.ts";
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

    // Delivery needs the parent's live AttachedSession, and there are normal
    // states where that route is closed (parent mid-compaction, process
    // restarted). The notice is recorded before the attempt and cleared only
    // once it lands, so a failed delivery leaves a record to retry from.
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
            await seedSession(parent);
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
            await seedSession(parent);
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
            await seedSession(parent);
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
            await seedSession(parent);
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
            await seedSession(parent);
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
