/**
 * config.compaction unit tests — validators, nested merge, disk round-trip key boundaries.
 *
 * Covers:
 *   - validateCompactionConfig valid/invalid inputs
 *   - mergeCompactionPatch field-level fallback and shallow merge
 *   - resolveConfig compaction resolution order: cli > global > default
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
    mergeCompactionPatch,
    readGlobalConfig,
    resolveConfig,
    saveGlobalConfig,
    validateCompactionConfig,
} from "../../src/config/config.ts";

describe("validateCompactionConfig", () => {
    it("returns undefined for nullish input", () => {
        assert.equal(validateCompactionConfig(undefined, "t"), undefined);
        assert.equal(validateCompactionConfig(null, "t"), undefined);
    });

    it("rejects non-object input", () => {
        assert.throws(() => validateCompactionConfig("not-an-object", "t"), /invalid compaction/);
        assert.throws(() => validateCompactionConfig([], "t"), /expected object/);
    });

    it("rejects invalid enabled type", () => {
        assert.throws(() => validateCompactionConfig({ enabled: "yes" }, "t"), /enabled.*boolean/);
    });

    it("rejects non-finite threshold", () => {
        assert.throws(
            () => validateCompactionConfig({ threshold: Number.NaN }, "t"),
            /finite number/,
        );
        assert.throws(
            () => validateCompactionConfig({ threshold: Number.POSITIVE_INFINITY }, "t"),
            /finite number/,
        );
    });

    it("rejects threshold outside the product clamp", () => {
        assert.throws(
            () => validateCompactionConfig({ threshold: 0.05 }, "t"),
            new RegExp(`${COMPACTION_THRESHOLD_MIN}.*${COMPACTION_THRESHOLD_MAX}`),
        );
        assert.throws(() => validateCompactionConfig({ threshold: 0.99 }, "t"), /must be in/);
    });

    it("applies default enabled when only threshold provided", () => {
        const r = validateCompactionConfig({ threshold: 0.5 }, "t");
        assert.deepEqual(r, { enabled: DEFAULT_COMPACTION_ENABLED, threshold: 0.5 });
    });

    it("applies default threshold when only enabled provided", () => {
        const r = validateCompactionConfig({ enabled: false }, "t");
        assert.deepEqual(r, { enabled: false, threshold: DEFAULT_COMPACTION_THRESHOLD });
    });

    it("accepts a full valid payload", () => {
        const r = validateCompactionConfig({ enabled: true, threshold: 0.8 }, "t");
        assert.deepEqual(r, { enabled: true, threshold: 0.8 });
    });
});

describe("mergeCompactionPatch", () => {
    const current = { enabled: true as boolean, threshold: 0.5 };

    it("returns current when patch is undefined or invalid", () => {
        assert.deepEqual(mergeCompactionPatch(current, undefined, "t"), current);
    });

    it("shallow-merges enabled overrides", () => {
        assert.deepEqual(mergeCompactionPatch(current, { enabled: false }, "t"), {
            enabled: false,
            threshold: 0.5,
        });
    });

    it("shallow-merges threshold without touching enabled", () => {
        assert.deepEqual(mergeCompactionPatch(current, { threshold: 0.8 }, "t"), {
            enabled: true,
            threshold: 0.8,
        });
    });

    it("rejects invalid enabled on patch", () => {
        assert.throws(
            () => mergeCompactionPatch(current, { enabled: "yes" as unknown as boolean }, "t"),
            /enabled.*boolean/,
        );
    });
});

describe("resolveConfig — compaction fallback chain", () => {
    let tmpDir: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpDir = mkdtempSync(join(tmpdir(), "taco-cfg-compaction-"));
        process.env.TACO_HOME = tmpDir;
    });

    after(() => {
        if (prevTacoHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevTacoHome;
        }
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("uses defaults when neither cli nor global is set", () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.compaction.enabled, DEFAULT_COMPACTION_ENABLED);
        assert.equal(cfg.compaction.threshold, DEFAULT_COMPACTION_THRESHOLD);
    });

    it("global file overrides defaults", () => {
        saveGlobalConfig({ compaction: { enabled: false, threshold: 0.55 } });
        const cfg = resolveConfig({});
        assert.deepEqual(cfg.compaction, { enabled: false, threshold: 0.55 });
    });

    it("cli overrides global field-by-field", () => {
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.5 } });
        const cfg = resolveConfig({
            compaction: { threshold: 0.85 },
        });
        assert.deepEqual(cfg.compaction, { enabled: true, threshold: 0.85 });
    });

    it("rejects invalid threshold from cli", () => {
        assert.throws(() => resolveConfig({ compaction: { threshold: 2 } }), /must be in/);
    });

    it("readGlobalConfig round-trips a compaction patch", () => {
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.6 } });
        assert.deepEqual(readGlobalConfig().compaction, {
            enabled: true,
            threshold: 0.6,
        });
    });

    it("a later save is visible on the very next read (no cache)", () => {
        // Regression: readGlobalConfig itself is not cached — every call hits readFileSync,
        // which is required by RPC handlers (e.g. settings.get) that need the absolute-fresh value.
        // CompactionController.effectiveCompaction() adds an additional 1s TTL cache on top
        // to reduce steady-state IO; writes call invalidate() to force immediate re-read.
        saveGlobalConfig({ compaction: { threshold: 0.7 } });
        assert.equal(readGlobalConfig().compaction?.threshold, 0.7);
        saveGlobalConfig({ compaction: { threshold: 0.15 } });
        assert.equal(readGlobalConfig().compaction?.threshold, 0.15);
    });
});

describe("resolveConfig — memoryEnabled passthrough", () => {
    let tmpDir: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpDir = mkdtempSync(join(tmpdir(), "taco-cfg-mem-"));
        process.env.TACO_HOME = tmpDir;
    });

    after(() => {
        if (prevTacoHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevTacoHome;
        }
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("is undefined when not set (default = enabled)", () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.memoryEnabled, undefined);
    });

    it("copies memoryEnabled: false from global config", () => {
        saveGlobalConfig({ memoryEnabled: false });
        assert.equal(resolveConfig({}).memoryEnabled, false);
    });

    it("cli override wins over global", () => {
        saveGlobalConfig({ memoryEnabled: false });
        assert.equal(resolveConfig({ memoryEnabled: true }).memoryEnabled, true);
    });
});
