/**
 * parseModelWindow — the provider panel's context-window field.
 *
 * The failure this guards: a silent parseInt turned "1024k" into 1024, and
 * the usage ring read 44x over the window. Shorthand must expand, garbage
 * must mean "no value" (server default), never a truncated number.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatModelWindow, parseModelWindow } from "../../src/lib/modelWindow.ts";

describe("parseModelWindow", () => {
    it("accepts a plain token count", () => {
        assert.equal(parseModelWindow("128000"), 128000);
        assert.equal(parseModelWindow(" 1000000 "), 1000000);
    });

    it("expands the k/m shorthand, case-insensitive", () => {
        assert.equal(parseModelWindow("128k"), 128000);
        assert.equal(parseModelWindow("1024K"), 1024000);
        assert.equal(parseModelWindow("1m"), 1000000);
        assert.equal(parseModelWindow("1.5m"), 1500000);
    });

    it("tolerates a space before the suffix", () => {
        assert.equal(parseModelWindow("256 k"), 256000);
    });

    it("rejects anything that is not a count — undefined keeps the default", () => {
        assert.equal(parseModelWindow(""), undefined);
        assert.equal(parseModelWindow("   "), undefined);
        assert.equal(parseModelWindow("abc"), undefined);
        assert.equal(parseModelWindow("1.2.3"), undefined);
        assert.equal(parseModelWindow("12x"), undefined);
        assert.equal(parseModelWindow("0"), undefined);
        assert.equal(parseModelWindow("-5"), undefined);
    });
});

describe("formatModelWindow", () => {
    it("renders k/m shorthand for round values, raw digits otherwise", () => {
        assert.equal(formatModelWindow(32_000), "32k");
        assert.equal(formatModelWindow(1_000_000), "1m");
        assert.equal(formatModelWindow(200_000), "200k");
        assert.equal(formatModelWindow(999_999), "999999");
    });
});
