import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { Value } from "typebox/value";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { pdfToolCandidates } from "../../src/tools/pdfCandidates.ts";
import { createPdfTools } from "../../src/tools/pdfTools.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { buildTextPdf } from "./pdfFixtures.ts";

const cwd = mkdtempSync(join(tmpdir(), "taco-pdf-tools-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

const PDF_TOOL_NAMES = ["pdfMerge", "pdfSplit", "pdfFill", "pdfFields"];
const PDF_TOOLS = createPdfTools();

function tool(name: string) {
    const found = PDF_TOOLS.find((t) => t.name === name);
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
    for (const field of ["source", "page", "from", "to"] as const) {
        const name = field === "source" || field === "page" ? "pdfMerge" : "pdfSplit";
        const paramsFor = (value: number) =>
            name === "pdfMerge"
                ? {
                      inputs: ["validation.pdf"],
                      output: `invalid-${field}.pdf`,
                      pages: [{ source: 1, page: 1, [field]: value }],
                  }
                : {
                      input: "validation.pdf",
                      outputDir: `invalid-${field}`,
                      ranges: [{ from: 1, to: 2, [field]: value }],
                  };

        it(`requires ${field} to be an integer at least 1 in the schema`, () => {
            assert.equal(Value.Check(tool(name).parameters, paramsFor(1)), true);
            assert.equal(Value.Check(tool(name).parameters, paramsFor(2)), true);
            for (const value of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity]) {
                assert.equal(
                    Value.Check(tool(name).parameters, paramsFor(value)),
                    false,
                    `${value}`,
                );
            }
        });

        for (const value of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity]) {
            it(`returns a readable failure for ${field} ${value} when schema validation is bypassed`, async () => {
                writeFileSync(join(cwd, "validation.pdf"), await pdfWithWidths([200, 300]));
                const result = await call(name, paramsFor(value));
                assert.match(textOf(result.content), /integer|does not exist|no input/);
                const output =
                    name === "pdfMerge"
                        ? `invalid-${field}.pdf`
                        : join(`invalid-${field}`, "validation-1.pdf");
                assert.equal(existsSync(join(cwd, output)), false);
            });
        }
    }

    it("is deferred: absent from the resident set, offered as builtin candidates", async () => {
        const resident = defaultTools().map((t) => t.name);
        for (const name of PDF_TOOL_NAMES) {
            assert.ok(!resident.includes(name), `${name} must not be resident`);
        }
        const candidates = pdfToolCandidates();
        assert.deepEqual(candidates.map((c) => c.name).sort(), [...PDF_TOOL_NAMES].sort());
        for (const candidate of candidates) {
            assert.equal(candidate.loading, "deferred");
            assert.equal(candidate.source, "builtin");
            const loaded = await candidate.load();
            assert.equal(loaded.name, candidate.name);
        }
    });

    it("refuses every PDF tool when the IM policy denies filesystem tools", async () => {
        // The load gates and the catalog are name-driven, so a tool whose
        // execute forgot the refusal would sail through all of them (a tool
        // loaded before a mid-process flip stays installed — kept
        // semantics). Pin all four; `refuseInIm` is the first statement of
        // each execute, so empty params are fine.
        for (const name of PDF_TOOL_NAMES) {
            await assert.rejects(
                invokeTool(
                    tool(name) as never,
                    {} as never,
                    {
                        env: new NodeExecutionEnv({ cwd }),
                        fsToolsDenied: true,
                    } as never,
                ),
                /not available in this session/,
            );
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

    it("accepts inclusive first and last page boundaries through the split tool", async () => {
        writeFileSync(join(cwd, "boundaries.pdf"), await pdfWithWidths([200, 300]));
        const params = {
            input: "boundaries.pdf",
            ranges: [
                { from: 1, to: 1 },
                { from: 2, to: 2 },
            ],
            outputDir: "boundaries",
        };
        assert.equal(Value.Check(tool("pdfSplit").parameters, params), true);
        assert.match(textOf((await call("pdfSplit", params)).content), /Wrote 2 file/);
        for (const [index, width] of [200, 300].entries()) {
            const part = await PDFDocument.load(
                readFileSync(join(cwd, "boundaries", `boundaries-${index + 1}.pdf`)),
            );
            assert.deepEqual(
                part.getPages().map((page) => page.getWidth()),
                [width],
            );
        }
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

    it("keeps a page list in the order the caller gave", async () => {
        writeFileSync(join(cwd, "wide-a.pdf"), await pdfWithWidths([200, 210]));
        writeFileSync(join(cwd, "wide-b.pdf"), await pdfWithWidths([300, 310, 500]));
        const result = await call("pdfMerge", {
            inputs: ["wide-a.pdf", "wide-b.pdf"],
            output: "ordered.pdf",
            pages: [
                { source: 2, page: 3 },
                { source: 1, page: 1 },
            ],
        });
        assert.match(textOf(result.content), /2 page/);
        const doc = await PDFDocument.load(readFileSync(join(cwd, "ordered.pdf")));
        assert.deepEqual(
            doc.getPages().map((page) => page.getWidth()),
            [500, 200],
        );
    });

    it("names a source the call does not have", async () => {
        writeFileSync(join(cwd, "one.pdf"), await pdfWithWidths([200]));
        const result = await call("pdfMerge", {
            inputs: ["one.pdf"],
            output: "missing-source.pdf",
            pages: [{ source: 3, page: 1 }],
        });
        assert.match(textOf(result.content), /no input 3/);
    });

    it("writes a split with an empty output directory inside the cwd", async () => {
        writeFileSync(join(cwd, "bare.pdf"), await pdfWithWidths([200]));
        const result = await call("pdfSplit", {
            input: "bare.pdf",
            ranges: [{ from: 1, to: 1 }],
            outputDir: "",
        });
        const text = textOf(result.content);
        assert.match(text, /bare-1\.pdf/);
        assert.doesNotMatch(text, /\/bare-1\.pdf/);
        assert.ok(existsSync(join(cwd, "bare-1.pdf")));
    });
});

async function pdfWithWidths(widths: number[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const width of widths) doc.addPage([width, 100]);
    return doc.save();
}
