import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BINARY_READ_MARKER } from "@taco-ai/protocol";
import { commandOnPath } from "../../src/lib/commandOnPath.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { binaryReadHint } from "../../src/tools/binaryRead.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { buildImageOnlyPdf, buildTextPdf } from "./pdfFixtures.ts";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
}

describe("binaryReadHint", () => {
    const missing = () => false;
    const present = () => true;

    it("leaves ordinary text alone", () => {
        assert.equal(binaryReadHint("hello\n", "notes.txt", missing), undefined);
    });

    it("does not treat a sentence that mentions PK or PDF as a binary file", () => {
        assert.equal(binaryReadHint("PK is a zip marker\n", "notes.txt", missing), undefined);
        assert.equal(binaryReadHint("%PDF is a header\n", "notes.txt", missing), undefined);
    });

    it("refuses a PDF header instead of returning the bytes", () => {
        const hint = binaryReadHint("%PDF-1.7\nbinary", "report.pdf", missing);
        assert.ok(hint?.startsWith(BINARY_READ_MARKER));
        assert.ok(hint?.includes("PDF"));
        assert.ok(hint?.includes("report.pdf"));
        assert.equal(hint?.includes("%PDF-1.7"), false);
    });

    it("refuses a later PDF page when the header was skipped", () => {
        const hint = binaryReadHint("stream\n\0\xff", "report.pdf", missing);
        assert.ok(hint?.includes("PDF"));
    });

    it("names the Office format and the install steps when officecli is missing", () => {
        const hint = binaryReadHint("PK\u0003\u0004xxxx", "q.docx", missing);
        assert.ok(hint?.includes("Word document"));
        assert.ok(hint?.includes('officecli view "q.docx" text'));
        assert.ok(hint?.includes("https://d.officecli.ai/install.sh"));
    });

    it("omits the install steps when officecli is already on PATH", () => {
        const hint = binaryReadHint("PK\u0003\u0004xxxx", "q.xlsx", present);
        assert.ok(hint?.includes("Excel workbook"));
        assert.equal(hint?.includes("not on PATH"), false);
    });

    it("does not tell a plain zip to install officecli", () => {
        const hint = binaryReadHint("PK\u0003\u0004xxxx", "bundle.zip", missing);
        assert.ok(hint?.includes("ZIP archive"));
        assert.equal(hint?.includes("not on PATH"), false);
    });

    it("keeps a labeled decode when NUL bytes may be a legacy encoding", () => {
        const hint = binaryReadHint("hello\0world", "data.bin", missing);
        assert.ok(hint?.startsWith(BINARY_READ_MARKER));
        assert.match(hint ?? "", /iconv/);
        assert.match(hint ?? "", /hello\\0world/);
    });

    it("does not treat a few replacement characters as binary", () => {
        const text = `${"a".repeat(200)}${"\uFFFD".repeat(4)}${"b".repeat(200)}`;
        assert.equal(binaryReadHint(text, "notes.txt", missing), undefined);
    });

    it("does not treat a short legacy-encoding sample as binary", () => {
        const text = "\uFFFD".repeat(8) + "ab";
        assert.equal(binaryReadHint(text, "notes.txt", missing), undefined);
    });

    it("keeps a truncated decode when replacement characters dominate", () => {
        const text = "\uFFFD".repeat(40) + "keep-this";
        const hint = binaryReadHint(text, "legacy.txt", missing);
        assert.ok(hint?.startsWith(BINARY_READ_MARKER));
        assert.match(hint ?? "", /iconv/);
        assert.match(hint ?? "", /keep-this/);
    });

    it("does not rewrite pi's own image message", () => {
        assert.equal(
            binaryReadHint("Read image file [image/bmp]\n[Image omitted]", "a.bmp", missing),
            undefined,
        );
    });
});

describe("commandOnPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-path-"));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("finds an executable in the given PATH and ignores a path-shaped name", () => {
        const fileName = process.platform === "win32" ? "officecli.exe" : "officecli";
        const file = join(dir, fileName);
        writeFileSync(file, "");
        chmodSync(file, 0o755);
        assert.equal(commandOnPath("officecli", { PATH: dir }), true);
        assert.equal(commandOnPath("missing", { PATH: dir }), false);
        assert.equal(commandOnPath(`../${fileName}`, { PATH: dir }), false);
        if (process.platform !== "win32") {
            chmodSync(file, 0o644);
            assert.equal(commandOnPath("officecli", { PATH: dir }), false);
        }
    });
});

class CountingEnv extends NodeExecutionEnv {
    reads = 0;
    override async readBinaryFile(
        path: string,
        context: Parameters<NodeExecutionEnv["readBinaryFile"]>[1],
    ) {
        this.reads += 1;
        return super.readBinaryFile(path, context);
    }
}

describe("read tool binary guard", () => {
    const cwd = mkdtempSync(join(tmpdir(), "taco-read-"));
    after(() => rmSync(cwd, { recursive: true, force: true }));

    function read(path: string, extra?: { offset?: number }) {
        const tool = defaultTools().find((t) => t.name === "read");
        assert.ok(tool);
        return invokeTool(tool, { path, ...extra }, { env: new NodeExecutionEnv({ cwd }) });
    }

    it("still returns text and images", async () => {
        writeFileSync(join(cwd, "notes.txt"), "hello\n");
        writeFileSync(join(cwd, "dot.png"), PNG);
        const text = await read("notes.txt");
        assert.equal(textOf(text), "hello\n");
        const image = await read("dot.png");
        assert.ok(image.content.some((block) => block.type === "image"));
    });

    it("replaces a NUL file with a hint, and still throws when the file is missing", async () => {
        writeFileSync(join(cwd, "data.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe]));
        const bin = textOf(await read("data.bin"));
        assert.match(bin, /binary/);
        await assert.rejects(() => read("missing.txt"));
    });

    it("extracts a PDF's text instead of decoding its bytes", async () => {
        writeFileSync(
            join(cwd, "report.pdf"),
            buildTextPdf(["Quarterly revenue", "up 12 percent"]),
        );
        const pdf = textOf(await read("report.pdf"));
        assert.match(pdf, /Quarterly revenue/);
        assert.match(pdf, /up 12 percent/);
        assert.equal(pdf.includes("obj"), false);
    });

    it("returns page images for a scanned PDF that has no text layer", async () => {
        writeFileSync(join(cwd, "scan.pdf"), buildImageOnlyPdf());
        const result = await read("scan.pdf");
        const images = result.content.filter((block) => block.type === "image");
        assert.equal(images.length, 1);
        assert.equal((images[0] as { mimeType: string }).mimeType, "image/png");
    });

    it("points an Office file at officecli, including install steps only when the binary is absent", async () => {
        writeFileSync(join(cwd, "q.docx"), Buffer.from("PK\u0003\u0004xxxx"));
        const hint = textOf(await read("q.docx"));
        assert.match(hint, /Word document/);
        assert.match(hint, /officecli/);
        if (commandOnPath("officecli")) {
            assert.equal(hint.includes("not on PATH"), false);
        } else {
            assert.match(hint, /not on PATH/);
        }
    });

    it("returns the original text when a file only mentions the PDF header", async () => {
        const body = "see the %PDF-1.7 header in the spec\n";
        writeFileSync(join(cwd, "spec-notes.txt"), body);
        assert.equal(textOf(await read("spec-notes.txt")), body);
    });

    it("reads a non-PDF once and a PDF once", async () => {
        writeFileSync(join(cwd, "once.txt"), "hello\n");
        writeFileSync(join(cwd, "once.pdf"), buildTextPdf(["hello"]));
        const tool = defaultTools().find((t) => t.name === "read");
        assert.ok(tool);
        const textEnv = new CountingEnv({ cwd });
        await invokeTool(tool, { path: "once.txt" }, { env: textEnv });
        assert.equal(textEnv.reads, 1);
        const pdfEnv = new CountingEnv({ cwd });
        await invokeTool(tool, { path: "once.pdf" }, { env: pdfEnv });
        assert.equal(pdfEnv.reads, 1);
    });

    it("keeps the routing summary inside the prompt budget", () => {
        const tool = defaultTools().find((t) => t.name === "read");
        const summary = tool?.taco?.promptSummary ?? "";
        assert.ok(summary.includes("binary"));
        assert.ok(summary.length <= 350, `promptSummary is ${summary.length} chars`);
    });
});
