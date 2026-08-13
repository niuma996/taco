/**
 * Regression: `readGlobalConfig` must NOT silently swallow a broken taco.json.
 *
 * The previous `readJsonOrEmpty` returned `{}` on any read/parse failure, and
 * `loadGlobalConfig` cached that empty result for the process lifetime. The
 * desktop then showed blank MCP / providers / channels panes even though the
 * tools loaded from the same file at startup kept working — "tools visible,
 * config invisible", fixed only by restarting the sidecar.
 *
 * This file pins the new contract: a malformed file throws (surfacing the
 * real cause through settings.get instead of a silent empty view), and a
 * transient failure does not poison the process-level cache — the next call
 * retries.
 *
 * Each test gets its own TACO_HOME: the module cache is keyed by config path,
 * so a fresh path per case guarantees the cache starts cold.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/config/config.corrupt.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";

describe("config corrupt-file handling", () => {
    const dirs: string[] = [];
    let prevTacoHome: string | undefined;

    after(() => {
        if (prevTacoHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevTacoHome;
        }
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    /** Point TACO_HOME at a fresh empty temp dir — cold cache for this test. */
    function useFreshHome(): string {
        if (prevTacoHome === undefined) prevTacoHome = process.env.TACO_HOME;
        const dir = mkdtempSync(join(tmpdir(), "taco-config-corrupt-"));
        dirs.push(dir);
        process.env.TACO_HOME = dir;
        return dir;
    }

    it("throws on malformed JSON instead of silently returning {}", () => {
        const dir = useFreshHome();
        writeFileSync(join(dir, "taco.json"), "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);
    });

    it("recovers after the file is repaired — a failure must not poison the cache", () => {
        const dir = useFreshHome();
        const path = join(dir, "taco.json");
        writeFileSync(path, "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);

        // Repair the file: the next read must succeed, proving the failed read
        // was not frozen into the process cache.
        writeFileSync(path, JSON.stringify({ defaultModel: "anthropic/claude-sonnet" }), "utf8");
        assert.equal(readGlobalConfig().defaultModel, "anthropic/claude-sonnet");
    });

    it("a missing file is unconfigured ({}), not an error", () => {
        useFreshHome();
        assert.deepEqual(readGlobalConfig(), {});
    });

    it("saveGlobalConfig also refuses to run on a corrupt file (no silent wipe)", () => {
        const dir = useFreshHome();
        const path = join(dir, "taco.json");
        writeFileSync(path, "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);

        // A save on a corrupt file reads it first (readJsonOrEmpty) to merge the
        // patch — that read throws, so the save aborts instead of replacing the
        // user's config with a patch-only file. This is the safe failure mode.
        assert.throws(() => saveGlobalConfig({ defaultProvider: "anthropic" }));
        // The corrupt original is left untouched on disk.
        assert.equal(readFileSync(path, "utf8"), "{this is not valid json");
    });
});
