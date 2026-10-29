import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { renderScan } from "../../src/tools/pdfIntercept.ts";
import { canvasInstallCommand, loadCanvas } from "../../src/tools/pdfRender.ts";
import { buildImageOnlyPdf, buildTextPdf } from "./pdfFixtures.ts";

describe("renderScan", () => {
    it("renders the pages of a document with no text layer", async () => {
        const result = await renderScan(buildImageOnlyPdf(), "scan.pdf");
        assert.ok(result);
        assert.equal(result.images.length, 1);
        assert.equal(result.images[0].page, 1);
        assert.equal(result.images[0].mimeType, "image/png");
        // A rendered page is a real PNG, not an empty buffer.
        assert.ok(result.images[0].data.length > 100);
        assert.match(result.text, /rendered as images/);
        assert.equal(result.text.includes("so they can be read"), false);
    });

    it("renders the pages of a document that does have a text layer too", async () => {
        const result = await renderScan(buildTextPdf(["some text"], 2), "a.pdf");
        assert.ok(result);
        assert.equal(result.images.length, 2);
    });

    it("explains that the pages could not be rendered when the document is broken", async () => {
        const result = await renderScan(new TextEncoder().encode("not a pdf"), "x.pdf");
        assert.ok(result);
        assert.equal(result.images.length, 0);
        assert.match(result.text, /could not be rendered/);
    });

    it("names the vendor install and does not suggest officecli when canvas is missing", async () => {
        const result = await renderScan(buildImageOnlyPdf(), "scan.pdf", async () => undefined);
        assert.equal(result.images.length, 0);
        assert.match(result.text, /no text layer/);
        assert.match(result.text, /npm install --prefix/);
        assert.match(result.text, /@napi-rs\/canvas@1\.0\.13/);
        assert.equal(result.text.includes("officecli"), false);
        assert.equal(result.text.includes("pnpm add"), false);
    });
});

describe("loadCanvas", () => {
    it("pins the canvas version the package declares", () => {
        const pkg = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { optionalDependencies: Record<string, string> };
        assert.match(
            canvasInstallCommand(),
            new RegExp(`@napi-rs/canvas@${pkg.optionalDependencies["@napi-rs/canvas"]}$`),
        );
    });

    it("loads a vendor install when the package import fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "taco-canvas-"));
        const prev = process.env.TACO_HOME;
        process.env.TACO_HOME = dir;
        try {
            const pkgDir = join(dir, "vendor", "node_modules", "@napi-rs", "canvas");
            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(join(dir, "vendor", "package.json"), '{"private":true}\n');
            writeFileSync(join(pkgDir, "package.json"), '{"main":"index.js"}\n');
            writeFileSync(join(pkgDir, "index.js"), "module.exports = { fromVendor: true };\n");
            const canvas = await loadCanvas(async () => {
                throw new Error("not installed");
            });
            assert.equal((canvas as { fromVendor?: boolean } | undefined)?.fromVendor, true);
            assert.ok(canvasInstallCommand().includes(join(dir, "vendor")));
        } finally {
            if (prev === undefined) delete process.env.TACO_HOME;
            else process.env.TACO_HOME = prev;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
