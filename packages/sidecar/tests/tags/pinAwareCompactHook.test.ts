/**
 * buildPinAwareCompactHook — pin directive lands on customInstructions.
 *
 * The production compact() call is injected so these cases assert the merge
 * without a provider round-trip. A forgotten merge (passing event.customInstructions
 * straight through) would let the summarizer paraphrase pin bodies with no
 * other regression catching it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
    CompactionPreparation,
    CompactResult,
    Model,
    Models,
} from "../../src/runtime/pi/types.ts";
import { Result } from "../../src/runtime/pi/values.ts";
import { buildPinnedDirective } from "../../src/tags/policy/compression.ts";
import { buildPinAwareCompactHook } from "../../src/tags/policy/pinAwareCompact.ts";

function emptyPrep(): CompactionPreparation {
    return {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        retainedTail: [],
        isSplitTurn: false,
        tokensBefore: 0,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1000 },
    } as CompactionPreparation;
}

function pinnedPrep(): CompactionPreparation {
    const prep = emptyPrep();
    prep.messagesToSummarize = [
        {
            role: "user",
            content: '<skill_body name="rule">NEVER touch prod</skill_body>\nplease continue',
            timestamp: 0,
        } as never,
    ];
    return prep;
}

function stubCompact(captured: {
    customInstructions?: string;
}): typeof import("../../src/runtime/pi/values.ts").compact {
    return (async (_prep, _models, _model, customInstructions) => {
        captured.customInstructions = customInstructions;
        const value: CompactResult = {
            summary: "seven-section",
            tokensBefore: 0,
            retainedTail: [],
            details: { readFiles: [], modifiedFiles: [] },
        };
        return Result.ok(value);
    }) as typeof import("../../src/runtime/pi/values.ts").compact;
}

function hookFor(compact: typeof import("../../src/runtime/pi/values.ts").compact) {
    return buildPinAwareCompactHook({
        models: {} as Models,
        getModel: async () => ({ id: "m" }) as Model<never>,
        getRetryPolicy: async () => ({}) as never,
        compact,
    });
}

describe("buildPinAwareCompactHook customInstructions", () => {
    it("forwards caller instructions unchanged when nothing is pinned", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        const result = await hook({
            preparation: emptyPrep(),
            customInstructions: "be terse",
        });
        assert.ok(result?.compaction);
        assert.equal(captured.customInstructions, "be terse");
    });

    it("uses the pin directive alone when auto-compact has no caller text", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        await hook({ preparation: pinnedPrep() });
        const expected = buildPinnedDirective(["skill_body"]);
        assert.equal(captured.customInstructions, expected);
    });

    it("keeps caller instructions ahead of the pin directive", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        await hook({
            preparation: pinnedPrep(),
            customInstructions: "be terse",
        });
        assert.ok(captured.customInstructions?.startsWith("be terse"));
        assert.ok(captured.customInstructions?.includes("skill_body"));
    });

    it("appends the pin tail after the pi summary", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        const result = await hook({ preparation: pinnedPrep() });
        assert.ok(result?.compaction);
        assert.ok(result.compaction.summary.startsWith("seven-section"));
        assert.match(result.compaction.summary, /PINNED \(verbatim/);
        assert.match(result.compaction.summary, /NEVER touch prod/);
    });

    it("declines when the lane has no model", async () => {
        const hook = buildPinAwareCompactHook({
            models: {} as Models,
            getModel: async () => undefined,
            getRetryPolicy: async () => ({}) as never,
            compact: stubCompact({}),
        });
        assert.equal(await hook({ preparation: pinnedPrep() }), undefined);
    });
});
