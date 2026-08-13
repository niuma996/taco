/**
 * mergeInstructionsPatch / validateInstructionsConfig — nested merge behaviour + type
 * validation consistent with mergeCompactionPatch; ensures settings.write partial
 * patch only flips the named leaf, preserving other base values; rejects malformed
 * input before it reaches disk.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mergeInstructionsPatch, validateInstructionsConfig } from "../../src/config/config.ts";

describe("validateInstructionsConfig", () => {
    it("returns undefined for null/undefined input", () => {
        assert.equal(validateInstructionsConfig(undefined, "t"), undefined);
        assert.equal(validateInstructionsConfig(null, "t"), undefined);
    });

    it("throws on non-object input", () => {
        assert.throws(() => validateInstructionsConfig("yes", "t"), /expected object/);
        assert.throws(() => validateInstructionsConfig([], "t"), /expected object/);
    });

    it("throws on invalid leaf types", () => {
        assert.throws(
            () => validateInstructionsConfig({ enabled: "yes" as unknown as boolean }, "t"),
            /enabled.*boolean/,
        );
        assert.throws(
            () => validateInstructionsConfig({ files: { claudeMd: 1 as unknown as boolean } }, "t"),
            /files\.claudeMd.*boolean/,
        );
        assert.throws(
            () =>
                validateInstructionsConfig(
                    { filesOverride: { agentsMd: 42 as unknown as string } },
                    "t",
                ),
            /filesOverride\.agentsMd.*string/,
        );
        assert.throws(
            () =>
                validateInstructionsConfig(
                    { inheritToSubagents: "true" as unknown as boolean },
                    "t",
                ),
            /inheritToSubagents.*boolean/,
        );
    });

    it("passes through a valid patch unchanged", () => {
        const patch = {
            enabled: false,
            files: { claudeMd: true, designMd: true },
            inheritToSubagents: false,
        };
        assert.deepEqual(validateInstructionsConfig(patch, "t"), patch);
    });
});

describe("mergeInstructionsPatch", () => {
    it("returns current when patch is undefined", () => {
        const current = { enabled: true };
        assert.deepEqual(mergeInstructionsPatch(current, undefined, "t"), current);
    });

    it("shallow-merges enabled without touching files", () => {
        const current = { files: { claudeMd: true, agentsMd: false } };
        const merged = mergeInstructionsPatch(current, { enabled: false }, "t");
        assert.deepEqual(merged, {
            enabled: false,
            files: { claudeMd: true, agentsMd: false },
        });
    });

    it("deep-merges files — a partial patch flips only the named leaf", () => {
        const current = { files: { claudeMd: true, agentsMd: true, designMd: false } };
        const merged = mergeInstructionsPatch(current, { files: { claudeMd: false } }, "t");
        assert.deepEqual(merged, {
            files: { claudeMd: false, agentsMd: true, designMd: false },
        });
    });

    it("deep-merges filesOverride without touching files", () => {
        const current = { files: { claudeMd: true } };
        const merged = mergeInstructionsPatch(
            current,
            { filesOverride: { agentsMd: "/docs/AGENTS.md" } },
            "t",
        );
        assert.deepEqual(merged, {
            files: { claudeMd: true },
            filesOverride: { agentsMd: "/docs/AGENTS.md" },
        });
    });

    it("preserves base inheritToSubagents when patch omits it", () => {
        const current = { inheritToSubagents: false };
        const merged = mergeInstructionsPatch(current, { enabled: true }, "t");
        assert.deepEqual(merged, { enabled: true, inheritToSubagents: false });
    });

    it("does NOT add empty files/filesOverride keys when neither side has them", () => {
        const merged = mergeInstructionsPatch(
            { enabled: true },
            { inheritToSubagents: false },
            "t",
        );
        assert.deepEqual(merged, { enabled: true, inheritToSubagents: false });
        if (!merged) throw new Error("expected merged");
        assert.ok(!("files" in merged));
        assert.ok(!("filesOverride" in merged));
    });

    it("rejects malformed patch via validate", () => {
        const current = { enabled: true };
        assert.throws(
            () =>
                mergeInstructionsPatch(
                    current,
                    { files: { claudeMd: "yes" as unknown as boolean } },
                    "t",
                ),
            /files\.claudeMd.*boolean/,
        );
    });
});
