import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { renderScan } from "../../src/tools/pdfIntercept.ts";
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
});
