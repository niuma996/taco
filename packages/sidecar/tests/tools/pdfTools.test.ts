import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { buildTextPdf } from "./pdfFixtures.ts";

const cwd = mkdtempSync(join(tmpdir(), "taco-pdf-tools-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

function tool(name: string) {
    const found = defaultTools().find((t) => t.name === name);
    assert.ok(found, `${name} is not registered`);
    return found;
}

interface ToolResult {
    content: { type: string; text?: string }[];
}

function call(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    return invokeTool(
        tool(name) as never,
        params as never,
        { env: new NodeExecutionEnv({ cwd }) } as never,
    ) as Promise<ToolResult>;
}

const textOf = (content: { type: string; text?: string }[]): string =>
    content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

describe("pdf tools", () => {
    it("registers the PDF tools", () => {
        const names = defaultTools().map((t) => t.name);
        for (const name of ["pdfMerge", "pdfSplit", "pdfFill", "pdfFields"]) {
            assert.ok(names.includes(name), `${name} is not registered`);
        }
    });

    it("merges two files into one", async () => {
        writeFileSync(join(cwd, "a.pdf"), buildTextPdf(["a"], 1));
        writeFileSync(join(cwd, "b.pdf"), buildTextPdf(["b"], 2));
        const result = await call("pdfMerge", {
            inputs: ["a.pdf", "b.pdf"],
            output: "merged.pdf",
        });
        assert.match(textOf(result.content), /Merged 2 file/);
        const doc = await PDFDocument.load(readFileSync(join(cwd, "merged.pdf")));
        assert.equal(doc.getPageCount(), 3);
    });

    it("splits a file by page range", async () => {
        const doc = await PDFDocument.create();
        for (let i = 0; i < 4; i++) doc.addPage([612, 792]);
        writeFileSync(join(cwd, "four.pdf"), await doc.save());
        const result = await call("pdfSplit", {
            input: "four.pdf",
            ranges: [{ from: 1, to: 2 }],
            outputDir: "parts",
        });
        assert.match(textOf(result.content), /Wrote 1 file/);
        const part = await PDFDocument.load(readFileSync(join(cwd, "parts", "four-1.pdf")));
        assert.equal(part.getPageCount(), 2);
    });

    it("lists the fields of a form", async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([612, 792]);
        const field = doc.getForm().createTextField("email");
        field.addToPage(page, { x: 72, y: 700, width: 200, height: 24 });
        writeFileSync(join(cwd, "form.pdf"), await doc.save());
        const result = await call("pdfFields", { input: "form.pdf" });
        assert.match(textOf(result.content), /email \(text\)/);
    });

    it("fills a form and writes the result", async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([612, 792]);
        const field = doc.getForm().createTextField("city");
        field.addToPage(page, { x: 72, y: 700, width: 200, height: 24 });
        writeFileSync(join(cwd, "city.pdf"), await doc.save());
        const result = await call("pdfFill", {
            input: "city.pdf",
            output: "city-filled.pdf",
            values: { city: "Lisbon" },
            flatten: false,
        });
        assert.match(textOf(result.content), /Filled 1 field/);
        assert.ok(existsSync(join(cwd, "city-filled.pdf")));
    });

    it("names the field a form does not have", async () => {
        const doc = await PDFDocument.create();
        doc.addPage([612, 792]);
        writeFileSync(join(cwd, "empty.pdf"), await doc.save());
        const result = await call("pdfFill", {
            input: "empty.pdf",
            output: "empty-filled.pdf",
            values: { missing: "x" },
        });
        assert.match(textOf(result.content), /no field named "missing"/);
    });
});
