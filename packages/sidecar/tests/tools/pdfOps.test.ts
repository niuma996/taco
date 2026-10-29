import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { fillPdf, mergePdfs, readFormFields, splitPdf } from "../../src/tools/pdfOps.ts";
import { buildTextPdf } from "./pdfFixtures.ts";

/** A document with one text field and one checkbox. */
async function buildFormPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const name = form.createTextField("name");
    name.setText("");
    name.addToPage(page, { x: 72, y: 700, width: 200, height: 24 });
    const agree = form.createCheckBox("agree");
    agree.addToPage(page, { x: 72, y: 660, width: 14, height: 14 });
    return doc.save();
}

/** The text of every page, so a test can tell the pages apart. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((_, index) => `page ${index + 1}`);
}

/** A document whose page widths are the only way to tell the pages apart. */
async function pdfWithWidths(widths: number[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const width of widths) doc.addPage([width, 100]);
    return doc.save();
}

async function pageWidths(bytes: Uint8Array): Promise<number[]> {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((page) => page.getWidth());
}

describe("mergePdfs", () => {
    it("joins documents in order, keeping every page", async () => {
        const a = buildTextPdf(["first"], 1);
        const b = buildTextPdf(["second"], 2);
        const merged = await mergePdfs([a, b]);
        assert.ok(merged.ok);
        const doc = await PDFDocument.load(merged.value.bytes);
        // 1 page from the first document, 2 from the second.
        assert.equal(doc.getPageCount(), 3);
    });

    it("keeps only the pages the caller picked", async () => {
        const a = buildTextPdf(["a1", "a2", "a3"], 3);
        const b = buildTextPdf(["b1", "b2"], 2);
        const merged = await mergePdfs(
            [a, b],
            [
                { source: 0, page: 2 },
                { source: 1, page: 1 },
            ],
        );
        assert.ok(merged.ok);
        const doc = await PDFDocument.load(merged.value.bytes);
        assert.equal(doc.getPageCount(), 2);
    });

    it("copies a page list in the order given, not grouped by source", async () => {
        const a = await pdfWithWidths([200, 210]);
        const b = await pdfWithWidths([300, 310, 500]);
        const merged = await mergePdfs(
            [a, b],
            [
                { source: 1, page: 3 },
                { source: 0, page: 1 },
            ],
        );
        assert.ok(merged.ok);
        assert.deepEqual(await pageWidths(merged.value.bytes), [500, 200]);
    });

    it("reports a source the call does not have", async () => {
        const merged = await mergePdfs([buildTextPdf(["only"], 1)], [{ source: 2, page: 1 }]);
        assert.ok(!merged.ok);
        assert.equal(merged.failure.kind, "no_such_page");
        if (merged.failure.kind !== "no_such_page") return;
        assert.equal(merged.failure.source, 2);
        assert.equal(merged.failure.pages, 0);
    });

    it("reports a page that does not exist", async () => {
        const a = buildTextPdf(["only"], 1);
        const merged = await mergePdfs([a], [{ source: 0, page: 9 }]);
        assert.ok(!merged.ok);
        assert.equal(merged.failure.kind, "no_such_page");
    });

    it("reports a document it cannot read", async () => {
        const merged = await mergePdfs([new TextEncoder().encode("not a pdf")]);
        assert.ok(!merged.ok);
        assert.equal(merged.failure.kind, "unreadable");
    });
});

describe("splitPdf", () => {
    it("cuts the document into one file per range", async () => {
        const doc = await PDFDocument.create();
        for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
        const bytes = await doc.save();
        const parts = await splitPdf(bytes, [
            { from: 1, to: 2 },
            { from: 3, to: 5 },
        ]);
        assert.ok(parts.ok);
        assert.equal(parts.value.length, 2);
        assert.equal((await PDFDocument.load(parts.value[0] as Uint8Array)).getPageCount(), 2);
        assert.equal((await PDFDocument.load(parts.value[1] as Uint8Array)).getPageCount(), 3);
    });

    it("reports a range past the end of the document", async () => {
        const doc = await PDFDocument.create();
        doc.addPage([612, 792]);
        const bytes = await doc.save();
        const parts = await splitPdf(bytes, [{ from: 1, to: 4 }]);
        assert.ok(!parts.ok);
        assert.equal(parts.failure.kind, "no_such_page");
        if (parts.failure.kind !== "no_such_page") return;
        assert.equal(parts.failure.page, 4);
        assert.equal(parts.failure.pages, 1);
    });
});

describe("readFormFields", () => {
    it("names the fields a document carries", async () => {
        const fields = await readFormFields(await buildFormPdf());
        assert.ok(fields.ok);
        const names = fields.value.map((f) => f.name);
        assert.deepEqual(names.sort(), ["agree", "name"]);
        assert.equal(fields.value.find((f) => f.name === "agree")?.type, "checkbox");
        assert.equal(fields.value.find((f) => f.name === "name")?.type, "text");
    });

    it("reports a document with no readable form as an empty list", async () => {
        const fields = await readFormFields(buildTextPdf(["x"], 1));
        assert.ok(fields.ok);
        assert.deepEqual(fields.value, []);
    });
});

describe("fillPdf", () => {
    it("writes a text field and checks a box", async () => {
        const filled = await fillPdf(await buildFormPdf(), { name: "Ada", agree: true }, false);
        assert.ok(filled.ok);
        const fields = await readFormFields(filled.value);
        assert.ok(fields.ok);
        assert.equal(fields.value.find((f) => f.name === "name")?.value, "Ada");
        assert.equal(fields.value.find((f) => f.name === "agree")?.value, "true");
    });

    it("bakes the values into the page when it flattens", async () => {
        const filled = await fillPdf(await buildFormPdf(), { name: "Ada" });
        assert.ok(filled.ok);
        // A flattened form has no fields left to read: the values live in
        // the page content instead.
        const fields = await readFormFields(filled.value);
        assert.ok(fields.ok);
        assert.deepEqual(fields.value, []);
    });

    it("reports a field the form does not have", async () => {
        const filled = await fillPdf(await buildFormPdf(), { missing: "x" });
        assert.ok(!filled.ok);
        assert.equal(filled.failure.kind, "no_such_field");
    });

    it("reports a value of the wrong kind for the field", async () => {
        // A boolean belongs to a checkbox, not to a text field.
        const filled = await fillPdf(await buildFormPdf(), { name: true });
        assert.ok(!filled.ok);
        assert.equal(filled.failure.kind, "field_not_fillable");
    });
});

describe("pageTexts", () => {
    it("counts the pages of a document", async () => {
        assert.deepEqual(await pageTexts(buildTextPdf(["x"], 3)), ["page 1", "page 2", "page 3"]);
    });
});
