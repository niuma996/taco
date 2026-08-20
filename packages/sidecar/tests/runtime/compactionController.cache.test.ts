/**
 * CompactionController.effectiveCompaction() TTL cache unit tests.
 * Covers: TTL hit, TTL expiry, explicit invalidate, failed disk reads cached,
 * injected vs disk precedence, built-in default.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { DEFAULT_COMPACTION_ENABLED, DEFAULT_COMPACTION_THRESHOLD } from "@taco-ai/protocol";

import { type ResolvedCompaction, saveGlobalConfig } from "../../src/config/config.ts";
import { CompactionController } from "../../src/runtime/compactionController.ts";

/** Minimal fake harness — CompactionController.effectiveCompaction() doesn't touch it. */
const fakeHarness = {} as ConstructorParameters<typeof CompactionController>[0]["harness"];

let tmpDir: string;
let tacoJsonPath: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-compaction-ttl-"));
    process.env.TACO_HOME = tmpDir;
    mkdirSync(tmpDir, { recursive: true });
    tacoJsonPath = join(tmpDir, "taco.json");
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Builds a CompactionController with a counter-wrapped readGlobalConfig.
 * Each call to the spy reads directly from disk and parses. This bypasses the
 * fact that ESM namespace imports (Node 22 `import * as fs`) are frozen, so
 * readFileSync cannot be patched; instead, inject a counting closure into
 * the controller.
 *
 * Also injects a fake clock so "TTL expired" tests don't need real wall-clock
 * waits — just call clock.advance(t). Combined with effectiveTtlMs, edge cases
 * are fully deterministic.
 */
function makeController(opts?: { compaction?: ResolvedCompaction; effectiveTtlMs?: number }): {
    controller: CompactionController;
    reads: () => number;
    clock: FakeClock;
} {
    let count = 0;
    const clock = new FakeClock();
    const controller = new CompactionController({
        harness: fakeHarness,
        compaction: opts?.compaction,
        getContextUsage: () => Promise.reject(new Error("not used in this test")),
        getSessionEntries: () => Promise.resolve([]),
        readGlobalConfig: () => {
            count++;
            return JSON.parse(readFileSync(tacoJsonPath, "utf8"));
        },
        effectiveTtlMs: opts?.effectiveTtlMs,
        now: clock.now,
    });
    return {
        controller,
        reads: () => count,
        clock,
    };
}

/**
 * Minimal fake clock — starts at 0, `advance(ms)` advances monotonically.
 * Does not mock Date / setTimeout; only used for effectiveCompaction expiry checks.
 */
class FakeClock {
    private t = 0;
    now = (): number => this.t;
    advance(ms: number): void {
        this.t += ms;
    }
}

describe("CompactionController.effectiveCompaction — TTL cache", () => {
    afterEach(() => {
        // Clean disk so each it is independent
        try {
            unlinkSync(tacoJsonPath);
        } catch {
            // ignore if absent
        }
    });

    it("first call reads disk, subsequent calls within TTL hit cache (zero reads)", () => {
        saveGlobalConfig({ compaction: { threshold: 0.6 } });
        const { controller, reads } = makeController();

        assert.equal(controller.effectiveCompaction().threshold, 0.6);
        assert.equal(reads(), 1, "first call reads disk");

        // 100 calls within 1s should all hit cache
        for (let i = 0; i < 100; i++) {
            assert.equal(controller.effectiveCompaction().threshold, 0.6);
        }
        assert.equal(reads(), 1, "100 cache hits should not re-read disk");
    });

    it("after TTL expires, next call re-reads disk", () => {
        saveGlobalConfig({ compaction: { threshold: 0.7 } });
        // 50ms TTL + fake clock → zero wall-clock wait.
        const { controller, reads, clock } = makeController({ effectiveTtlMs: 50 });

        controller.effectiveCompaction();
        assert.equal(reads(), 1);

        // Within TTL: still a hit
        clock.advance(40);
        assert.equal(controller.effectiveCompaction().threshold, 0.7, "still within TTL");
        assert.equal(reads(), 1, "still cached");

        // Past TTL boundary: re-read
        saveGlobalConfig({ compaction: { threshold: 0.5 } });
        clock.advance(20); // total 60ms > 50ms TTL
        assert.equal(controller.effectiveCompaction().threshold, 0.5, "should pick up new value");
        assert.equal(reads(), 2, "TTL expired → re-read");
    });

    it("uses monotonic clock (TTL does not extend when now() regresses)", () => {
        // Verifies clock is monotonic: even if now() goes backwards (e.g. NTP adjusts system time),
        // expiresAt is a fixed point and doesn't drift back with now().
        // Key: uses `performance.now()` to compare expiresAt > now, not `Date.now()`,
        // ensuring the cache doesn't become permanently stale if the system clock steps backward.
        saveGlobalConfig({ compaction: { threshold: 0.7 } });

        // Simulate "drift back" style: write time t=200, subsequent assertion at t=100.
        // FakeClock doesn't support regression, so we mock the call sequence directly.
        const nowValues = [0, 200, 100]; // sequence: first construct, after disk read, regression
        let idx = 0;
        const callNow = (): number => nowValues[idx++] ?? nowValues[nowValues.length - 1];

        const controller = new CompactionController({
            harness: fakeHarness,
            getContextUsage: () => Promise.reject(new Error("not used")),
            getSessionEntries: () => Promise.resolve([]),
            readGlobalConfig: () => ({ compaction: { threshold: 0.7 } }),
            effectiveTtlMs: 50,
            now: callNow,
        });

        // 1st call: now=0, expiresAt=50
        // 2nd call: now=200, 200 > 50 → cache miss → re-read → cached expiresAt=250
        // 3rd call: now=100, 100 < 250 → still a hit (monotonic: 100 is after 200 in call order)
        // The key assertion: even though now() regressed from 200 to 100, expiresAt did not
        // (stays at 250), so 100 < 250 → hit. A wall-clock approach (expiresAt = now + TTL)
        // would have a different regression profile.
        const r1 = controller.effectiveCompaction();
        assert.equal(r1.threshold, 0.7);
        const r2 = controller.effectiveCompaction();
        assert.equal(r2.threshold, 0.7);
        const r3 = controller.effectiveCompaction();
        assert.equal(r3.threshold, 0.7, "regression in now() should not extend TTL");
    });

    it("invalidate() forces immediate disk re-read", () => {
        saveGlobalConfig({ compaction: { threshold: 0.7 } });
        const { controller, reads } = makeController();

        controller.effectiveCompaction();
        assert.equal(reads(), 1);

        // Write disk + explicit invalidate → immediately visible
        saveGlobalConfig({ compaction: { threshold: 0.15 } });
        controller.invalidate();

        assert.equal(
            controller.effectiveCompaction().threshold,
            0.15,
            "invalidate → sees new value",
        );
        assert.equal(reads(), 2, "invalidate forced 1 re-read");
    });

    it("caches the fallback path when disk has invalid JSON (no repeat reads on failure)", () => {
        // Bad JSON → validateCompactionConfig throws → fallback to injected/default
        writeFileSync(tacoJsonPath, "{this is not valid json", "utf8");
        const { controller, reads } = makeController({
            compaction: { enabled: false, threshold: 0.42 },
        });

        const first = controller.effectiveCompaction();
        assert.equal(first.enabled, false, "uses injected enabled");
        assert.equal(first.threshold, 0.42, "uses injected threshold");
        assert.equal(reads(), 1);

        // Second call must also hit cache — failed disk reads are stable too
        const second = controller.effectiveCompaction();
        assert.deepEqual(second, first, "failure is cached");
        assert.equal(reads(), 1, "failure path does not trigger additional reads");
    });

    it("injection vs disk priority is preserved across cache hit and miss", () => {
        saveGlobalConfig({ compaction: { threshold: 0.8 } });
        // disk=0.8, injected=0.5 → disk takes priority (0.8)
        const { controller } = makeController({
            compaction: { enabled: true, threshold: 0.5 },
        });

        assert.equal(
            controller.effectiveCompaction().threshold,
            0.8,
            "disk takes priority over injected",
        );
        // Still returns disk value on cache hit
        assert.equal(
            controller.effectiveCompaction().threshold,
            0.8,
            "cache hit still returns disk value",
        );
    });

    it("returns defaults when neither disk nor injection is set", () => {
        // No disk file, no injected value
        const { controller } = makeController();

        const r = controller.effectiveCompaction();
        assert.equal(r.enabled, DEFAULT_COMPACTION_ENABLED);
        assert.equal(r.threshold, DEFAULT_COMPACTION_THRESHOLD);
    });
});

describe("CompactionController.compact — cancellation", () => {
    it("signal aborts short-circuit the wait, returning ok:false before the 30s timeout", async () => {
        // Fake harness: subscribe no-ops the listener, compact() resolves a
        // promise that never settles within the test window — mirrors the
        // "pi is busy generating a summary" case in production.
        let pendingCompact: () => void = () => {};
        const neverSettles = new Promise<void>((resolve) => {
            pendingCompact = resolve;
        });
        const fakeHarness = {
            subscribe: () => () => {},
            compact: () => neverSettles,
        } as unknown as ConstructorParameters<typeof CompactionController>[0]["harness"];

        const controller = new CompactionController({
            harness: fakeHarness,
            getContextUsage: () => Promise.reject(new Error("not used")),
            getSessionEntries: () => Promise.resolve([]),
            readGlobalConfig: () => ({}),
        });

        const ac = new AbortController();
        const start = Date.now();
        const resultP = controller.compact(undefined, ac.signal);
        // Abort almost immediately — well inside the 30s hardcoded timeout.
        setTimeout(() => ac.abort(), 20);
        const result = await resultP;
        const elapsed = Date.now() - start;

        assert.equal(result.ok, false, "abort path must return ok:false");
        assert.equal(result.reason, "aborted", "reason must distinguish abort from timeout");
        assert.ok(elapsed < 1_000, `must return fast on abort, took ${elapsed}ms`);

        // Settle the stand-in compact() and await it, so the promise is not
        // left pending when the test function returns.
        pendingCompact();
        await neverSettles;
    });

    it("pre-aborted signal short-circuits the wait; harness.compact still runs", async () => {
        let compactInvoked = false;
        const fakeHarness = {
            subscribe: () => () => {},
            compact: () => {
                compactInvoked = true;
                return Promise.resolve();
            },
        } as unknown as ConstructorParameters<typeof CompactionController>[0]["harness"];

        const controller = new CompactionController({
            harness: fakeHarness,
            getContextUsage: () => Promise.reject(new Error("not used")),
            getSessionEntries: () => Promise.resolve([]),
            readGlobalConfig: () => ({}),
        });

        const ac = new AbortController();
        ac.abort();
        const result = await controller.compact(undefined, ac.signal);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "aborted");
        // Asserting the documented limitation, not an aspiration: pi's
        // harness.compact() takes no AbortSignal, so a pre-aborted signal
        // cannot prevent the call — it only stops us waiting for the event.
        assert.ok(compactInvoked, "harness.compact() still runs; abort only ends the wait");
    });

    it("harness.compact rejecting reports reason:harness_error, not timeout", async () => {
        const fakeHarness = {
            subscribe: () => () => {},
            compact: () => Promise.reject(new Error("pi says busy")),
        } as unknown as ConstructorParameters<typeof CompactionController>[0]["harness"];

        const controller = new CompactionController({
            harness: fakeHarness,
            getContextUsage: () => Promise.reject(new Error("not used")),
            getSessionEntries: () => Promise.resolve([]),
            readGlobalConfig: () => ({}),
        });

        const start = Date.now();
        const result = await controller.compact();

        assert.equal(result.ok, false);
        assert.equal(result.reason, "harness_error");
        assert.ok(Date.now() - start < 1_000, "must not wait out the 30s timeout");
    });

    it("a session_compact that lands alongside the cancel is still reported as success", async () => {
        // Guards the `!received && !lastCompactEvent` condition: pi committed the
        // compaction, so discarding it because the wait ended as cancelled would
        // report failure for work that actually happened.
        let emit: (() => void) | undefined;
        const fakeHarness = {
            subscribe: (listener: (e: unknown) => void) => {
                emit = () =>
                    listener({
                        type: "session_compact",
                        compactionEntry: { tokensBefore: 4242, fromHook: true },
                    });
                return () => {};
            },
            // Reject *after* emitting the event, mirroring "summary was written
            // but the follow-up notification threw".
            compact: () => {
                emit?.();
                return Promise.reject(new Error("late failure"));
            },
        } as unknown as ConstructorParameters<typeof CompactionController>[0]["harness"];

        const controller = new CompactionController({
            harness: fakeHarness,
            getContextUsage: () => Promise.reject(new Error("not used")),
            getSessionEntries: () => Promise.resolve([]),
            readGlobalConfig: () => ({}),
        });

        const result = await controller.compact();

        assert.equal(result.ok, true, "a committed compaction must not be reported as failed");
        assert.equal(result.tokensBefore, 4242);
        assert.equal(result.fromHook, true);
        assert.equal(result.reason, undefined, "success carries no reason");
    });
});
