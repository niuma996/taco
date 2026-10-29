import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isPdfBytes, readPdf } from "../../src/tools/pdfIntercept.ts";
import { buildImageOnlyPdf, buildTextPdf } from "./pdfFixtures.ts";

describe("isPdfBytes", () => {
    it("recognises a PDF by its magic", () => {
        assert.equal(isPdfBytes(buildTextPdf(["hello"])), true);
    });

    it("does not mistake ordinary text for a PDF", () => {
        assert.equal(isPdfBytes(new TextEncoder().encode("hello\nworld\n")), false);
    });

    it("does not mistake an empty file for a PDF", () => {
        assert.equal(isPdfBytes(new Uint8Array()), false);
    });

    it("finds the magic after leading junk, which some writers prepend", () => {
        const pdf = buildTextPdf(["hello"]);
        const withJunk = new Uint8Array(pdf.length + 4);
        withJunk.set(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 0);
        withJunk.set(pdf, 4);
        assert.equal(isPdfBytes(withJunk), true);
    });
});

describe("readPdf", () => {
    it("returns the document's text layer", async () => {
        const result = await readPdf(
            buildTextPdf(["first line", "second line"]),
            "a.pdf",
            undefined,
            undefined,
        );
        assert.equal(result.extracted, true);
        assert.match(result.text, /first line/);
        assert.match(result.text, /second line/);
    });

    it("reports the page count", async () => {
        const result = await readPdf(
            buildTextPdf(["a", "b", "c", "d"], 2),
            "a.pdf",
            undefined,
            undefined,
        );
        assert.match(result.text, /2 page\(s\)/);
    });

    it("pages the text with offset and limit, like any other file", async () => {
        const bytes = buildTextPdf(["l1", "l2", "l3", "l4", "l5"]);
        const first = await readPdf(bytes, "a.pdf", 1, 2);
        assert.match(first.text, /l1/);
        assert.match(first.text, /l2/);
        assert.equal(first.text.includes("l3"), false);
        assert.match(first.text, /Use offset=3 to continue/);

        const second = await readPdf(bytes, "a.pdf", 3, 2);
        assert.match(second.text, /l3/);
        assert.equal(second.text.includes("l1"), false);
    });

    it("says so when the offset is past the end", async () => {
        const result = await readPdf(buildTextPdf(["l1"]), "a.pdf", 99, undefined);
        assert.equal(result.extracted, false);
        assert.match(result.text, /beyond end of document/);
    });

    it("says a scan has no text layer instead of returning nothing", async () => {
        const result = await readPdf(buildImageOnlyPdf(), "scan.pdf", undefined, undefined);
        assert.equal(result.extracted, false);
        // Without @napi-rs/canvas the pages cannot be rendered, and the result
        // says so instead of pretending the document is empty.
        assert.match(result.text, /no text layer/);
    });

    it("reads the same bytes twice — PDF.js detaches the buffer it is handed", async () => {
        const bytes = buildTextPdf(["same line"]);
        const first = await readPdf(bytes, "a.pdf", undefined, undefined);
        const second = await readPdf(bytes, "a.pdf", undefined, undefined);
        assert.equal(first.extracted, true);
        assert.equal(second.extracted, true);
        assert.match(second.text, /same line/);
    });

    it("reports a file that is not a PDF at all", async () => {
        const result = await readPdf(
            new TextEncoder().encode("not a pdf"),
            "x.pdf",
            undefined,
            undefined,
        );
        assert.equal(result.extracted, false);
        assert.equal(result.fallback, true);
        assert.match(result.text, /could not be parsed/);
    });

    it("caps an omitted limit at 2000 lines, even when a larger limit is asked for", async () => {
        // One page only yields the lines that fit on it, so the document is
        // spread across pages to give the cap more than 2000 lines to cut.
        const lines = Array.from({ length: 2100 }, (_, i) => `n${i + 1}`);
        const result = await readPdf(buildTextPdf(lines, 80), "long.pdf", undefined, 5000);
        assert.match(result.text, /\bn1\b/);
        assert.equal(result.text.includes("n2100"), false);
        assert.match(result.text, /Showing lines 1-2000 of \d+/);
        assert.match(result.text, /Use offset=2001 to continue/);
    });

    it("stops before the extracted text crosses 50KB", async () => {
        const lines = Array.from(
            { length: 1400 },
            (_, i) => `L${String(i + 1).padStart(4, "0")}${"x".repeat(36)}`,
        );
        const result = await readPdf(buildTextPdf(lines, 50), "wide.pdf", undefined, undefined);
        assert.match(result.text, /L0001/);
        assert.equal(result.text.includes("L1400"), false);
        assert.match(result.text, /\(50\.0KB limit\)/);
        assert.match(result.text, /Use offset=\d+ to continue/);
    });
});
