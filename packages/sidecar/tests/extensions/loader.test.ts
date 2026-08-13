/**
 * loader.ts unit tests.
 *
 * Validates:
 *   - Directory discovery scans TACO_EXTENSIONS_DIR (test override)
 *   - Extensions with missing/invalid manifest are skipped, not fatal
 *   - apiVersion mismatch is rejected
 *   - Permission-undeclared register* calls are recorded in report
 *   - A throwing extension module is skipped, others still load
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadExtensions } from "../../src/extensions/loader.ts";

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ext-loader-"));
    process.env.TACO_EXTENSIONS_DIR = join(tmpDir, "ext-home");
    mkdirSync(process.env.TACO_EXTENSIONS_DIR, { recursive: true });
});

after(() => {
    process.env.TACO_EXTENSIONS_DIR = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
});

const makeExt = (name: string, body: string) => {
    const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            name,
            version: "0.0.1",
            main: "index.js",
            taco: { apiVersion: "1", permissions: ["context", "tools", "systemPrompt"] },
        }),
    );
    writeFileSync(join(dir, "index.js"), body);
};

describe("loadExtensions — directory discovery", () => {
    it("loads a valid extension from TACO_EXTENSIONS_DIR", async () => {
        makeExt(
            "good-ext",
            `export default function (taco) { taco.registerSystemPrompt({ append: "FROM GOOD" }); }`,
        );
        const r = await loadExtensions({ extensions: [] });
        const contribs = r.systemPromptContributors().map((c) => c.append);
        assert.ok(contribs.includes("FROM GOOD"), `got: ${JSON.stringify(contribs)}`);
    });

    it("skips an extension whose factory throws", async () => {
        makeExt("bad-ext", `export default function () { throw new Error("nope"); }`);
        const r = await loadExtensions({ extensions: [] });
        const failed = r.report.failed.find((f) => f.name === "bad-ext");
        assert.ok(failed, `expected bad-ext in failed, got: ${JSON.stringify(r.report.failed)}`);
    });

    it("rejects an extension with mismatched apiVersion", async () => {
        const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", "old-api-ext");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "old-api-ext",
                version: "0.0.1",
                taco: { apiVersion: "999", permissions: [] },
            }),
        );
        writeFileSync(join(dir, "index.js"), "export default function () {};");
        const r = await loadExtensions({ extensions: [] });
        const failed = r.report.failed.find((f) => f.name === "old-api-ext");
        assert.ok(failed, "expected old-api-ext in failed");
    });

    it("reads taco.description and taco.whenToUse from manifest", async () => {
        const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", "described-ext");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "described-ext",
                version: "0.0.1",
                main: "index.js",
                taco: {
                    apiVersion: "1",
                    permissions: ["systemPrompt"],
                    description: "adds a rule",
                    whenToUse: "always",
                },
            }),
        );
        writeFileSync(
            join(dir, "index.js"),
            `export default function (taco) { taco.registerSystemPrompt({ append: "X" }); }`,
        );
        const r = await loadExtensions({ extensions: [] });
        const entry = r.report.loaded.find((e) => e.name === "described-ext");
        assert.ok(entry, "described-ext should load");
        assert.equal(entry.description, "adds a rule");
        assert.equal(entry.whenToUse, "always");
    });

    it("skips a directory extension listed in disabledExtensions? (dir extensions are always scanned)", async () => {
        // Note: disabledExtensions only filters the npm allowlist (extensions field);
        // directory scanning is always the full set, unaffected by disabledExtensions.
        // This test pins down that semantic.
        makeExt(
            "dir-only",
            `export default function (taco) { taco.registerSystemPrompt({ append: "DIR" }); }`,
        );
        const r = await loadExtensions({ extensions: [], disabledExtensions: ["dir-only"] });
        // dir-only comes from directory scanning, not the npm extensions allowlist,
        // so disabledExtensions has no effect on it.
        assert.ok(r.report.loaded.some((e) => e.name === "dir-only"));
        // It should not appear in the disabled bucket (disabled only tracks extensions ∩ disabledExtensions).
        assert.ok(!r.report.disabled.includes("dir-only"));
    });

    it("records an npm-listed extension as disabled when in disabledExtensions", async () => {
        // Declare a package name under extensions and disable it at the same time —
        // it should land in the disabled bucket, not in loaded/failed.
        const r = await loadExtensions({
            extensions: ["some-absent-pkg"],
            disabledExtensions: ["some-absent-pkg"],
        });
        assert.ok(r.report.disabled.includes("some-absent-pkg"));
        assert.ok(!r.report.loaded.some((e) => e.name === "some-absent-pkg"));
        assert.ok(!r.report.failed.some((e) => e.name === "some-absent-pkg"));
    });

    it("records a built-in as disabled when listed in disabledExtensions; skips hook install", async () => {
        // The output-redaction builtin is normally registered automatically.
        // Listing it in disabledExtensions must:
        //   (a) remove it from report.loaded,
        //   (b) place it in report.disabled,
        //   (c) skip installing the toolResult interceptor so secrets pass through.
        const r = await loadExtensions({
            extensions: [],
            disabledExtensions: ["@taco/builtin-output-redaction"],
        });
        assert.ok(
            !r.report.loaded.some((e) => e.name === "@taco/builtin-output-redaction"),
            `builtin should NOT be loaded when disabled, got: ${JSON.stringify(r.report.loaded)}`,
        );
        assert.ok(r.report.disabled.includes("@taco/builtin-output-redaction"));
        assert.deepEqual(r.toolResultHooks().builtins, []);
    });

    it("default behavior: output-redaction builtin is registered when not disabled", async () => {
        // Sanity baseline so the previous test's assertion is meaningful.
        const r = await loadExtensions({ extensions: [] });
        assert.ok(r.report.loaded.some((e) => e.name === "@taco/builtin-output-redaction"));
        assert.equal(r.toolResultHooks().builtins.length, 1);
    });
});
