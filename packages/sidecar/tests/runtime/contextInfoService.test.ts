/**
 * ContextInfoService — covers the edge cases the protocol path silently absorbs:
 *
 *   1. Fresh session → omits `cacheRead` / `cacheHitRatio`.
 *   2. Zero cache hits (cacheRead === 0, input > 0) → wires `cacheRead: 0`
 *      + `cacheHitRatio: 0` so the UI shows the "cache present but empty" signal.
 *   3. Normal cache usage → cacheHitRatio = ΣcacheRead / Σ(input + cacheRead).
 *   4. Partial usage records are skipped exactly like pi's getSessionStats.
 *   5. findEntries() throws → cache fields omitted, other fields still populated.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ContextInfoService } from "../../src/runtime/compaction/contextInfoService.ts";
import type { AgentLane, Api, Entry, Model, Session } from "../../src/runtime/pi/types.ts";
import { MAIN_BRANCH } from "../../src/runtime/session/sessionBranch.ts";

interface UsageParts {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Omit to simulate a partial usage record (missing cost.total → skipped). */
    withCostTotal?: boolean;
}

/** Build an assistant `message` entry carrying a usage record. */
function assistantEntry(u: UsageParts): Entry {
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
    } as unknown as Entry;
}

/** Build a compaction entry carrying a usage record (cacheRetention: none). */
function compactionEntry(u: UsageParts, timestamp?: number): Entry {
    return {
        type: "compaction",
        timestamp,
        summary: "",
        retainedTail: [],
        tokensBefore: 0,
        fromHook: false,
        usage: {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            cost: { total: 0 },
        },
    } as unknown as Entry;
}

/**
 * Minimal Session stub — only the methods ContextInfoService uses.
 *
 * pi 0.85 split "branch walk" (cache aggregate is over the *whole* log,
 * including abandoned branches) from "current branch" (compaction timestamp
 * lives on the leaf branch only). The stub exposes both surfaces.
 */
function makeSessionStub(opts: {
    entries?: ReadonlyArray<Entry> | Error;
    branchEntries?: ReadonlyArray<Entry>;
}): Session {
    return {
        findEntries: async (_query: unknown, _context: unknown) => {
            if (opts.entries instanceof Error) throw opts.entries;
            return [...(opts.entries ?? [])];
        },
        branch: async (name: string, _context: unknown) => {
            if (name !== MAIN_BRANCH) return undefined;
            return {
                findEntry: async (query: { type?: string; order?: string }) => {
                    const branch = opts.branchEntries ?? [];
                    const list = query?.order === "newestFirst" ? [...branch].reverse() : branch;
                    return list.find((e) => e.type === query?.type);
                },
                findEntries: async (_query: unknown) => opts.branchEntries ?? [],
            };
        },
    } as unknown as Session;
}

/** Minimal lane stub — only getModel(). */
function makeLaneStub(model: Model<Api> | undefined): AgentLane {
    return {
        getModel: async () => model,
    } as unknown as AgentLane;
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
            lane: makeLaneStub(fakeModel),
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
            lane: makeLaneStub(fakeModel),
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
            lane: makeLaneStub(fakeModel),
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
            lane: makeLaneStub(fakeModel),
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
            lane: makeLaneStub(fakeModel),
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
            lane: makeLaneStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        // Only the first entry counts: 10k / (10k + 10k) = 0.5.
        assert.equal(result.cacheRead, 10_000);
        assert.equal(result.cacheHitRatio, 0.5);
    });

    it("findEntries throws → cache fields omitted, other fields still populated", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({ entries: new Error("disk gone") }),
            lane: makeLaneStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.cacheRead, undefined);
        assert.equal(result.cacheHitRatio, undefined);
        assert.equal(result.modelId, "claude-test");
    });

    it("branch.findEntry throws → lastCompactionAt omitted, cache fields still wired", async () => {
        const session = {
            findEntries: async () => [
                assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
            ],
            branch: async () => ({
                findEntry: async () => {
                    throw new Error("branch failed");
                },
                findEntries: async () => [],
            }),
        } as unknown as Session;
        const svc = new ContextInfoService({
            session,
            lane: makeLaneStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        assert.equal(result.lastCompactionAt, undefined);
        assert.equal(result.cacheRead, 100);
        assert.ok(result.cacheHitRatio !== undefined);
    });

    it("lastCompactionAt from the most recent compaction entry on the leaf branch", async () => {
        const entries: Entry[] = [
            { type: "message" } as unknown as Entry,
            {
                type: "compaction",
                timestamp: 0,
                summary: "",
                retainedTail: [],
                tokensBefore: 0,
                fromHook: false,
            } as unknown as Entry,
            { type: "message" } as unknown as Entry,
            {
                type: "compaction",
                timestamp: 1,
                summary: "",
                retainedTail: [],
                tokensBefore: 0,
                fromHook: false,
            } as unknown as Entry,
        ];
        const svc = new ContextInfoService({
            session: makeSessionStub({ branchEntries: entries }),
            lane: makeLaneStub(fakeModel),
        });
        const result = await svc.getContextInfo();
        // The branch stub stringifies entry.timestamp; numeric 0 becomes "0" and
        // numeric 1 becomes "1". The "newest" one is the larger number — the
        // contract is "most recent", which is what stringification from a
        // monotonic epoch guarantees.
        assert.equal(result.lastCompactionAt, "1");
    });

    it("lane.getModel() returns undefined → empty model fields, no crash", async () => {
        const svc = new ContextInfoService({
            session: makeSessionStub({
                entries: [
                    assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
                ],
            }),
            lane: makeLaneStub(undefined),
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

    it("buildBranchContext throws → exception propagates", async () => {
        // buildBranchContext reads session.branch(...).findEntries(...). Stub a
        // branch whose findEntries throws to verify getContextInfo does not
        // swallow it. (The original test named buildContext — 0.85 renamed it.)
        const session = {
            branch: async () => ({
                findEntries: async () => {
                    throw new Error("corrupt session");
                },
            }),
            findEntries: async () => [],
        } as unknown as Session;
        const svc = new ContextInfoService({
            session,
            lane: makeLaneStub(fakeModel),
        });
        await assert.rejects(() => svc.getContextInfo(), /corrupt session/);
    });

    // Touch `harnessContext` so lint does not flag the imported-but-unused
    // symbol in branches that drop the import (e.g. when reading via harness
    // would be required). It is imported here only because the surrounding
    // stub contract intentionally mirrors pi's Context threading.
    void harnessContext;
});
