// Product identity config: validation rules, the three absence semantics
// (absent / omitted / explicitly cleared), and the disk-read fallback.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    readGlobalConfig,
    resolveConfig,
    saveGlobalConfig,
    tacoHome,
} from "../../src/config/config.ts";
import { DEFAULT_PRODUCT_NAME, validateProductName } from "../../src/config/productIdentity.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("validateProductName", () => {
    it("accepts a plain product name", () => {
        assert.equal(validateProductName("Acme", "test"), "Acme");
    });

    it("accepts Chinese, spaces, digits and common name punctuation", () => {
        for (const name of ["阿克米", "Acme Corp", "Acme 2", "Acme, Inc.", "ACME-Labs"]) {
            assert.equal(validateProductName(name, "test"), name);
        }
    });

    it("normalizes decomposed accents and accepts scripts with combining marks", () => {
        assert.equal(validateProductName("Cafe\u0301", "test"), "Café");
        assert.equal(validateProductName("भारत", "test"), "भारत");
        assert.equal(validateProductName("e\u0301".repeat(80), "test"), "é".repeat(80));
    });

    it("trims surrounding whitespace", () => {
        assert.equal(validateProductName("  Acme  ", "test"), "Acme");
    });

    it("treats null, undefined and blank as 'no name'", () => {
        assert.equal(validateProductName(null, "test"), undefined);
        assert.equal(validateProductName(undefined, "test"), undefined);
        assert.equal(validateProductName("", "test"), undefined);
        assert.equal(validateProductName("   ", "test"), undefined);
    });

    it("rejects a non-string value", () => {
        assert.throws(() => validateProductName(42, "test"), /productName/);
    });

    it("rejects line breaks and control characters", () => {
        assert.throws(() => validateProductName("Acme\nCorp", "test"), /productName/);
        assert.throws(() => validateProductName("Acme\r\nCorp", "test"), /productName/);
        assert.throws(() => validateProductName("Acme\u2028Corp", "test"), /productName/);
        assert.throws(() => validateProductName("Acme\u0000Corp", "test"), /productName/);
        assert.throws(() => validateProductName("Acme\u202ECorp", "test"), /productName/);
    });

    it("rejects characters that could open a prompt section or template marker", () => {
        assert.throws(() => validateProductName("<Acme>", "test"), /productName/);
        assert.throws(() => validateProductName("{{PRODUCT_NAME}}", "test"), /productName/);
        assert.throws(() => validateProductName("Acme {x}", "test"), /productName/);
    });

    it("accepts 80 code points and rejects 81", () => {
        assert.equal(validateProductName("a".repeat(80), "test"), "a".repeat(80));
        assert.throws(() => validateProductName("a".repeat(81), "test"), /productName/);
    });

    it("counts code points, not UTF-16 units", () => {
        assert.equal(validateProductName("𠮷".repeat(80), "test"), "𠮷".repeat(80));
        assert.throws(() => validateProductName("𠮷".repeat(81), "test"), /longer than 80/);
    });
});

describe("productName in the global config", () => {
    useTempTacoHome("config-product-name");

    it("defaults to Taco when the field is absent", () => {
        assert.equal(resolveConfig().productName, DEFAULT_PRODUCT_NAME);
        assert.equal(readGlobalConfig().productName, undefined);
    });

    it("round-trips a saved value", () => {
        saveGlobalConfig({ productName: "Acme" });
        assert.equal(readGlobalConfig().productName, "Acme");
        assert.equal(resolveConfig().productName, "Acme");
    });

    it("keeps the saved value when a patch omits the field", () => {
        saveGlobalConfig({ productName: "Acme" });
        saveGlobalConfig({ defaultModel: "anthropic/claude-sonnet" });
        assert.equal(readGlobalConfig().productName, "Acme");
    });

    it("clears the override on an explicit null, storing no empty value", () => {
        saveGlobalConfig({ productName: "Acme" });
        saveGlobalConfig({ productName: null });
        assert.equal(readGlobalConfig().productName, undefined);
        assert.ok(!("productName" in readGlobalConfig()));
        assert.equal(resolveConfig().productName, DEFAULT_PRODUCT_NAME);
    });

    it("treats an empty or whitespace-only value as a clear", () => {
        saveGlobalConfig({ productName: "Acme" });
        saveGlobalConfig({ productName: "" });
        assert.ok(!("productName" in readGlobalConfig()));
        saveGlobalConfig({ productName: "Acme" });
        saveGlobalConfig({ productName: "   " });
        assert.ok(!("productName" in readGlobalConfig()));
    });

    it("rejects an invalid value instead of storing it", () => {
        saveGlobalConfig({ productName: "Acme" });
        assert.throws(() => saveGlobalConfig({ productName: "Acme\nCorp" }), /productName/);
        assert.throws(() => saveGlobalConfig({ productName: "<Acme>" }), /productName/);
        assert.equal(readGlobalConfig().productName, "Acme", "the stored value must survive");
    });
});

describe("productName read from a hand-edited config", () => {
    let dir: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        dir = mkdtempSync(join(tmpdir(), "taco-product-name-corrupt-"));
        process.env.TACO_HOME = dir;
    });

    after(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        rmSync(dir, { recursive: true, force: true });
    });

    it("falls back to the default instead of keeping the sidecar from starting", () => {
        writeFileSync(
            join(tacoHome(), "taco.json"),
            JSON.stringify({ productName: "Acme\nCorp" }),
            "utf8",
        );
        assert.equal(resolveConfig().productName, DEFAULT_PRODUCT_NAME);
    });
});
