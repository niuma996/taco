/**
 * deriveCompactionSettings — the threshold/keepRecent/reserve derivation.
 *
 * The boundary table is the contract: every row asserts that
 * `keepRecentTokens < triggerTokens`, which is what keeps `prepareCompaction`
 * from cutting nothing and returning `NothingToCompact`.
 *
 * Run via `node:test` (tsx loader).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    deriveCompactionSettings,
    triggerTokens,
} from "../../src/runtime/compaction/compactionSettings.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/runtime/pi/values.ts";

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
