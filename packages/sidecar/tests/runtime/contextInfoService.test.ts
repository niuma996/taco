/**
 * ContextInfoService — covers the edge cases the protocol path silently absorbs:
 *
 *   1. Fresh session → omits `cacheRead` / `cacheHitRatio`.
 *   2. Zero cache hits (cacheRead === 0, input > 0) → wires `cacheRead: 0`
 *      + `cacheHitRatio: 0` so the UI shows the "cache present but empty" signal.
 *   3. Normal cache usage → cacheHitRatio = ΣcacheRead / Σ(input + cacheRead).
 *   4. Partial usage records are skipped exactly like pi's getSessionStats.
 *   5. getEntries() throws → cache fields omitted, other fields still populated.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
    AgentHarness,
    ExecutionToolContext,
    Session,
    SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ContextInfoService } from "../../src/runtime/contextInfoService.ts";

interface UsageParts {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Omit to simulate a partial usage record (missing cost.total → skipped). */
    withCostTotal?: boolean;
}

/** Build an assistant `message` entry carrying a usage record. */
function assistantEntry(u: UsageParts): SessionTreeEntry {
    const usage: Record<string, unknown> = {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
    };
    if (u.withCostTotal !== false) usage.cost = { total: 0 };
    return {
        type: "message",
        message: { role: "assistant", usage },
    } as unknown as SessionTreeEntry;
}

/** Build a compaction entry carrying a usage record (cacheRetention: none). */
function compactionEntry(u: UsageParts, timestamp?: string): SessionTreeEntry {
    return {
        type: "compaction",
        timestamp,
        usage: {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            cost: { total: 0 },
        },
    } as unknown as SessionTreeEntry;
}

/** Minimal Session stub — only the methods ContextInfoService uses. */
function makeSessionStub(opts: {
    entries?: ReadonlyArray<SessionTreeEntry> | Error;
    branchEntries?: ReadonlyArray<{ type?: string; timestamp?: string }>;
    buildContextMessages?: ReadonlyArray<unknown>;
}): Session {
    return {
        buildContext: async () => ({
            messages: [...(opts.buildContextMessages ?? [])],
        }),
        getBranch: async () => [...(opts.branchEntries ?? [])],
        getEntries: async () => {
            if (opts.entries instanceof Error) throw opts.entries;
            return [...(opts.entries ?? [])];
        },
    } as unknown as Session;
}

/** Minimal harness stub — only getModel(). */
function makeHarnessStub(model: Model<Api> | undefined): AgentHarness<ExecutionToolContext> {
    return {
        getModel: () => model,
    } as unknown as AgentHarness<ExecutionToolContext>;
}

const fakeModel: Model<Api> = {
    id: "claude-test",
    provider: "anthropic",
    contextWindow: 200_000,
} as unknown as Model<Api>;

describe("ContextInfoService", () => {
    it("fresh session omits cache fields", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({ entries: [] }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, undefined);
        assert.equal(result.cacheHitRatio, undefined);
        assert.equal(result.usedTokens, 0);
        assert.equal(result.ratio, 0);
        assert.equal(result.contextWindow, 200_000);
    });

    it("input but zero cache hits → wires cacheRead:0 + ratio:0", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({ input: 50_000, output: 1000, cacheRead: 0, cacheWrite: 0 }),
                ],
            }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        // cacheRead=0 + cacheHitRatio=0 distinguishes "session has LLM traffic
        // but no cache hits" from `undefined` ("fresh session, no calls yet").
        assert.equal(result.cacheRead, 0);
        assert.equal(result.cacheHitRatio, 0);
    });

    it("hit rate = ΣcacheRead / Σ(input + cacheRead); cacheWrite + output excluded", async () => {
        // input=10k, cacheRead=30k, cacheWrite=99k, output=60k.
        // Hit rate (B) = 30 / (10 + 30) = 0.75.
        // cacheWrite (99k) and output (60k) must NOT be in the denominator.
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({
                        input: 10_000,
                        output: 60_000,
                        cacheRead: 30_000,
                        cacheWrite: 99_000,
                    }),
                ],
            }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, 30_000);
        assert.ok(
            Math.abs((result.cacheHitRatio ?? 0) - 0.75) < 1e-9,
            `expected 0.75, got ${result.cacheHitRatio}`,
        );
    });

    it("input=0 (all-cached prefix) → hit rate 100%", async () => {
        // Mirrors the real session that prompted the switch to formula B:
        // every input token was a cache hit, so hit rate must read 100%,
        // not be dragged down by the one-time cacheWrite.
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({ input: 0, output: 68, cacheRead: 6585, cacheWrite: 1911 }),
                    assistantEntry({ input: 0, output: 1150, cacheRead: 8420, cacheWrite: 7969 }),
                ],
            }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, 15_005);
        assert.equal(result.cacheHitRatio, 1);
    });

    it("compaction entry (cacheRead=0) drags hit rate down only via its own input", async () => {
        // A normal turn with a strong hit, then a compaction whose input is
        // fresh (cacheRead=0, cacheRetention:none). The compaction's input
        // enters the denominator; its large output does not.
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({ input: 0, output: 500, cacheRead: 40_000, cacheWrite: 5000 }),
                    compactionEntry({
                        input: 20_000,
                        output: 100_000,
                        cacheRead: 0,
                        cacheWrite: 0,
                    }),
                ],
            }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, 40_000);
        // 40k / (40k + 20k) = 0.666… — the 100k output does NOT appear.
        assert.ok(
            Math.abs((result.cacheHitRatio ?? 0) - 40_000 / 60_000) < 1e-9,
            `expected 0.667, got ${result.cacheHitRatio}`,
        );
    });

    it("partial usage records are skipped (missing cost.total)", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({
                        input: 10_000,
                        output: 100,
                        cacheRead: 10_000,
                        cacheWrite: 0,
                    }),
                    // This one is missing cost.total → must be skipped entirely.
                    assistantEntry({
                        input: 999_999,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        withCostTotal: false,
                    }),
                ],
            }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        // Only the first entry counts: 10k / (10k + 10k) = 0.5.
        assert.equal(result.cacheRead, 10_000);
        assert.equal(result.cacheHitRatio, 0.5);
    });

    it("getEntries throws → cache fields omitted, other fields still populated", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({ entries: new Error("disk gone") }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, undefined);
        assert.equal(result.cacheHitRatio, undefined);
        assert.equal(result.modelId, "claude-test");
    });

    it("getBranch throws → lastCompactionAt omitted, cache fields still wired", async () => {
        const session = {
            buildContext: async () => ({ messages: [] }),
            getBranch: async () => {
                throw new Error("branch failed");
            },
            getEntries: async () => [
                assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
            ],
        } as unknown as Session;
        const svc = new ContextInfoService({
            session,
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.lastCompactionAt, undefined);
        assert.equal(result.cacheRead, 100);
        assert.ok(result.cacheHitRatio !== undefined);
    });

    it("lastCompactionAt from the most recent compaction entry on the leaf branch", async () => {
        const entries = [
            { type: "message" },
            { type: "compaction", timestamp: "2026-01-01T00:00:00.000Z" },
            { type: "message" },
            { type: "compaction", timestamp: "2026-07-29T12:34:56.000Z" },
        ];
        const svc = new ContextInfoService({
            session: makeSessionStub({ branchEntries: entries }),
            harness: makeHarnessStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.lastCompactionAt, "2026-07-29T12:34:56.000Z");
    });

    it("harness.getModel() returns undefined → empty model fields, no crash", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
                ],
            }),
            harness: makeHarnessStub(undefined),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.modelId, "");
        assert.equal(result.provider, "");
        assert.equal(result.contextWindow, 0);
        assert.equal(result.ratio, 0);
        // cache fields still wire — they don't depend on the model.
        assert.equal(result.cacheRead, 100);
        assert.ok(result.cacheHitRatio !== undefined);
    });

    it("buildContext() throws → exception propagates", async () => {
        // getContextInfo calls getContextUsage first; if buildContext throws,
        // the whole RPC fails. This pins that we don't accidentally swallow
        // the error inside getContextInfo.
        const session = {
            buildContext: async () => {
                throw new Error("corrupt session");
            },
            getBranch: async () => [],
            getEntries: async () => [],
        } as unknown as Session;
        const svc = new ContextInfoService({
            session,
            harness: makeHarnessStub(fakeModel),
        });
        await assert.rejects(() => svc.getContextInfo(), /corrupt session/);
    });
});
