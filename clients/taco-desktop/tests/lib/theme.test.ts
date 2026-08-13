/**
 * resolveTheme pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:theme
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveTheme } from "../../src/lib/theme";

describe("resolveTheme", () => {
    it("passes through explicit light", () => {
        assert.equal(resolveTheme("light", true), "light");
        assert.equal(resolveTheme("light", false), "light");
    });

    it("passes through explicit dark", () => {
        assert.equal(resolveTheme("dark", true), "dark");
        assert.equal(resolveTheme("dark", false), "dark");
    });

    it("system follows the OS media-query result", () => {
        assert.equal(resolveTheme("system", true), "dark");
        assert.equal(resolveTheme("system", false), "light");
    });

    it("undefined preference falls back to system", () => {
        assert.equal(resolveTheme(undefined, true), "dark");
        assert.equal(resolveTheme(undefined, false), "light");
    });

    it("unknown/illegal value falls back to system instead of throwing", () => {
        // Disk settings.json may have been hand-written with bad values
        assert.equal(resolveTheme("neon" as never, true), "dark");
        assert.equal(resolveTheme("neon" as never, false), "light");
    });
});
