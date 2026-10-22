/**
 * Compaction settings: the effectiveCompaction TTL cache and the
 * threshold/keepRecent/reserve derivation that feeds prepareCompaction.
 */

import { strict as assert } from "node:assert";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_COMPACTION_ENABLED, DEFAULT_COMPACTION_THRESHOLD } from "@taco-ai/protocol";

import { type ResolvedCompaction, saveGlobalConfig } from "../../src/config/config.ts";
import { CompactionController } from "../../src/runtime/compaction/compactionController.ts";
import {
    deriveCompactionSettings,
    manualKeepRecentTokens,
    triggerTokens,
} from "../../src/runtime/compaction/compactionSettings.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/runtime/pi/values.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

/**
 * Minimal fake harness — CompactionController.effectiveCompaction() doesn't
 * touch it. The settings pair is only reached by `invalidate()`'s
 * fire-and-forget `syncSettings()`; it is present so that path degrades to a
 * no-op instead of throwing into the guard's catch.
 */
const fakeHarness = {
    events: {
        on:
            (_type: string, _listener: (event: unknown) => void): (() => void) =>
            () => {},
    },
    getCompactionSettings: async () => ({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
    }),
    setCompactionSettings: async () => {},
} as unknown as ConstructorParameters<typeof CompactionController>[0]["harness"];
/** Lane stub: every test here only exercises effectiveCompaction (no compact path). */
const fakeLane = {
    compact: async () => ({
        ok: true as const,
        value: { compaction: { status: "completed" as const, entryId: undefined } },
    }),
    runWhenIdle: (cb: () => unknown): Promise<void> => Promise.resolve(cb()).then(() => undefined),
    getModel: async () => undefined,
} as unknown as ConstructorParameters<typeof CompactionController>[0]["lane"];
/** getEntry stub: TTL/cache tests don't read compaction entries. */
const fakeGetEntry = async () => undefined;

const tacoJsonPath = join(useTempTacoHome("compaction-ttl"), "taco.json");

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
        lane: fakeLane,
        getEntry: fakeGetEntry,
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
            lane: fakeLane,
            getEntry: fakeGetEntry,
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

/** Every window/threshold pair from the design table, plus a tiny window. */
const WINDOWS = [1_000, 4_000, 32_000, 128_000, 200_000, 1_000_000];
const THRESHOLDS = [0.1, 0.3, 0.5, 0.7, 0.95];
const MIN_RESERVE_TOKENS = 4096;

describe("deriveCompactionSettings", () => {
    it("keeps the trigger strictly above the retained tail for every pair", () => {
        for (const contextWindow of WINDOWS) {
            for (const threshold of THRESHOLDS) {
                const settings = deriveCompactionSettings(true, threshold, contextWindow);
                const trigger = triggerTokens(contextWindow, threshold);
                assert.ok(
                    settings.keepRecentTokens < trigger || trigger === 0,
                    `ctx=${contextWindow} t=${threshold}: keep=${settings.keepRecentTokens} must stay under trigger=${trigger}`,
                );
            }
        }
    });

    it("never produces a non-positive reserve or keep budget", () => {
        for (const contextWindow of WINDOWS) {
            for (const threshold of THRESHOLDS) {
                const settings = deriveCompactionSettings(true, threshold, contextWindow);
                assert.ok(settings.reserveTokens > 0, `ctx=${contextWindow} t=${threshold}`);
                assert.ok(settings.keepRecentTokens > 0, `ctx=${contextWindow} t=${threshold}`);
            }
        }
    });

    it("caps reserve at pi's default so a high threshold cannot inflate it", () => {
        for (const contextWindow of WINDOWS) {
            for (const threshold of THRESHOLDS) {
                const settings = deriveCompactionSettings(true, threshold, contextWindow);
                assert.ok(
                    settings.reserveTokens <= DEFAULT_COMPACTION_SETTINGS.reserveTokens,
                    `ctx=${contextWindow} t=${threshold}: reserve=${settings.reserveTokens} exceeds the default cap`,
                );
            }
        }
    });

    it("documents that a tiny window's summary budget can exceed the cut", () => {
        // A 1000-token window at 0.7: trigger=700, keep=560, remaining=140.
        // The reserve floor is 4096, so the summary output budget is larger
        // than the source being summarized. `keep < trigger` still holds
        // (prepareCompaction cuts something); collapsing reserve to fit
        // remaining is the alternative this derivation rejects.
        const settings = deriveCompactionSettings(true, 0.7, 1_000);
        const trigger = triggerTokens(1_000, 0.7);
        const remaining = trigger - settings.keepRecentTokens;
        assert.equal(trigger, 700);
        assert.equal(settings.keepRecentTokens, 560);
        assert.equal(remaining, 140);
        assert.ok(settings.reserveTokens > remaining);
        assert.equal(settings.reserveTokens, MIN_RESERVE_TOKENS);
    });

    it("holds the overflow net at or after the trigger wherever the floor does not bind", () => {
        // reserve = min(default, max(4096, ctx*(1-t))), so the net
        // (`ctx - reserve`) reaches the trigger exactly when the model window
        // leaves at least 4096 tokens of headroom above the threshold. Below
        // that the floor wins and the net fires early by design — asserted
        // separately so the two regimes cannot silently merge.
        for (const contextWindow of WINDOWS) {
            for (const threshold of THRESHOLDS) {
                const headroom = Math.floor(contextWindow * (1 - threshold));
                const settings = deriveCompactionSettings(true, threshold, contextWindow);
                const label = `ctx=${contextWindow} t=${threshold}`;
                if (headroom >= MIN_RESERVE_TOKENS) {
                    const overflowNet = contextWindow - settings.reserveTokens;
                    assert.ok(
                        overflowNet >= triggerTokens(contextWindow, threshold),
                        `${label}: net=${overflowNet} would fire before the user's threshold`,
                    );
                } else {
                    assert.equal(settings.reserveTokens, MIN_RESERVE_TOKENS, label);
                }
            }
        }
    });

    it("scales the retained tail with the threshold (the fix for the constant 20k)", () => {
        const low = deriveCompactionSettings(true, 0.3, 200_000);
        const high = deriveCompactionSettings(true, 0.7, 200_000);
        assert.equal(low.keepRecentTokens, 30_000);
        assert.equal(high.keepRecentTokens, 70_000);
        assert.ok(
            high.keepRecentTokens > low.keepRecentTokens,
            "a higher threshold must retain more recent context",
        );
    });

    describe("design table", () => {
        const cases: Array<{
            window: number;
            threshold: number;
            reserve: number;
            keep: number;
            note: string;
        }> = [
            { window: 200_000, threshold: 0.7, reserve: 16_384, keep: 70_000, note: "default" },
            {
                window: 200_000,
                threshold: 0.1,
                reserve: 16_384,
                keep: 10_000,
                note: "most aggressive",
            },
            { window: 200_000, threshold: 0.5, reserve: 16_384, keep: 50_000, note: "" },
            {
                window: 200_000,
                threshold: 0.95,
                reserve: 10_000,
                keep: 95_000,
                note: "net meets trigger",
            },
            { window: 1_000_000, threshold: 0.7, reserve: 16_384, keep: 350_000, note: "" },
            { window: 128_000, threshold: 0.7, reserve: 16_384, keep: 44_800, note: "" },
            {
                window: 32_000,
                threshold: 0.7,
                reserve: 9_600,
                keep: 11_200,
                note: "small window meets",
            },
            {
                window: 32_000,
                threshold: 0.95,
                reserve: 4_096,
                keep: 15_200,
                note: "MIN_RESERVE wins",
            },
            {
                window: 32_000,
                threshold: 0.1,
                reserve: 16_384,
                keep: 2_560,
                note: "keepCeiling wins",
            },
            {
                window: 4_000,
                threshold: 0.7,
                reserve: 4_096,
                keep: 2_240,
                note: "pathological window",
            },
            {
                window: 1_000,
                threshold: 0.7,
                reserve: 4_096,
                keep: 560,
                note: "tiny window: remaining=140, summary budget exceeds source",
            },
        ];

        for (const c of cases) {
            it(`ctx=${c.window} threshold=${c.threshold}${c.note ? ` (${c.note})` : ""}`, () => {
                const settings = deriveCompactionSettings(true, c.threshold, c.window);
                assert.equal(settings.reserveTokens, c.reserve);
                assert.equal(settings.keepRecentTokens, c.keep);
            });
        }
    });

    describe("enabled", () => {
        it("passes through unchanged", () => {
            assert.equal(deriveCompactionSettings(false, 0.7, 200_000).enabled, false);
            assert.equal(deriveCompactionSettings(true, 0.7, 200_000).enabled, true);
        });

        it("still applies when the window is unknown", () => {
            // A user who turned auto-compaction off must have it off in pi's
            // turn-boundary check too, even before a model window is known.
            const settings = deriveCompactionSettings(false, 0.7, 0);
            assert.equal(settings.enabled, false);
        });
    });

    describe("unknown or invalid window", () => {
        it("falls back to pi's defaults without inventing numbers", () => {
            for (const contextWindow of [0, -1]) {
                const settings = deriveCompactionSettings(true, 0.7, contextWindow);
                assert.equal(settings.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
                assert.equal(
                    settings.keepRecentTokens,
                    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
                );
            }
        });

        it("returns a fresh object each call (callers may freeze or mutate theirs)", () => {
            const first = deriveCompactionSettings(true, 0.7, 0);
            const second = deriveCompactionSettings(true, 0.7, 0);
            assert.notEqual(first, second);
        });
    });
});

describe("triggerTokens", () => {
    it("is the user's threshold applied to the window", () => {
        assert.equal(triggerTokens(200_000, 0.7), 140_000);
        assert.equal(triggerTokens(200_000, 0.95), 190_000);
        assert.equal(triggerTokens(32_000, 0.1), 3_200);
    });

    it("floors rather than rounds, so the trigger never lands above budget", () => {
        assert.equal(triggerTokens(100_001, 0.7), 70_000);
    });
});

describe("manualKeepRecentTokens", () => {
    it("keeps 30% of current usage, not of the 1M-window auto trigger", () => {
        // The bug: Compact at 112k on MiniMax-M3 (window ~1M, auto keep 367k)
        // retained everything. Manual keep must be relative to usedTokens.
        assert.equal(manualKeepRecentTokens(112_310), 33_693);
    });

    it("stays strictly under usedTokens so prepareCompaction can cut", () => {
        for (const used of [1, 10, 100, 4_000, 32_000, 112_310, 1_000_000]) {
            const keep = manualKeepRecentTokens(used);
            assert.ok(keep > 0, `used=${used}`);
            assert.ok(keep < used || used <= 1, `used=${used} keep=${keep}`);
        }
    });

    it("uses 30% even on tiny conversations — the auto 4096 floor would no-op them", () => {
        assert.equal(manualKeepRecentTokens(1_000), 300);
        assert.equal(manualKeepRecentTokens(4_000), 1_200);
        assert.equal(manualKeepRecentTokens(900), 270);
    });
});
