/**
 * Hint text for a `read` that would otherwise return decoded binary.
 *
 * pi TextDecodes every non-image file. PDF is intercepted before the decoder
 * (see `pdfIntercept.ts`), so a PDF reaching this function is one the
 * interception could not parse — the hint then names the way out.
 * Office is identified by magic and refused: guessing from a raw dump is
 * worse than no bytes. A NUL or a high replacement-character ratio is only a
 * maybe: legacy encodings look the same, so that path keeps a short decode
 * and names a way to convert it.
 */

import { extname } from "node:path";
import { BINARY_READ_MARKER } from "@taco-ai/protocol";

import { OFFICECLI_MISSING_NOTE } from "../lib/officecliHint.ts";

const PDF_MAGIC = "%PDF-";
/** The header may sit inside the first 1024 bytes when a preamble precedes it. */
const PDF_MAGIC_WINDOW = 1024;
const ZIP_MAGICS = ["PK\u0003\u0004", "PK\u0001\u0002", "PK\u0005\u0006"];

/** Enough ASCII structure to be useful, not a second copy of a binary dump. */
const EXCERPT_CHARS = 400;

const OFFICE_KIND: Record<string, string> = {
    ".docx": "Word document",
    ".xlsx": "Excel workbook",
    ".pptx": "PowerPoint presentation",
};

/** Model-facing replacement for a binary read, or undefined when the text is fine. */
export function binaryReadHint(
    text: string,
    filePath: string,
    officecliOnPath: () => boolean,
): string | undefined {
    // pi's own image result — BMP without a processor is this sentence, not file bytes.
    if (text.startsWith("Read image file [")) return undefined;

    const ext = extname(filePath).toLowerCase();
    const head = text.slice(0, 8192);
    const binary = looksBinary(text);
    // offset/limit drops the magic header; the extension still picks the hint.
    // A preamble can push the header off offset 0, but only a binary file is
    // taken as a PDF that way — prose mentioning "%PDF-" keeps its text.
    if (head.startsWith(PDF_MAGIC) || (binary && hasPdfMagic(head)) || (ext === ".pdf" && binary)) {
        return marked(pdfHint(filePath));
    }
    if (isZip(head) || (OFFICE_KIND[ext] !== undefined && looksBinary(text))) {
        return marked(archiveHint(filePath, ext, officecliOnPath));
    }
    if (looksBinary(text)) return marked(genericHint(filePath, text));
    return undefined;
}

function marked(body: string): string {
    return `${BINARY_READ_MARKER}\n${body}`;
}

function isZip(head: string): boolean {
    return ZIP_MAGICS.some((magic) => head.startsWith(magic));
}

/**
 * A preamble may push the PDF header off offset 0 — the spec allows it — so
 * the lead window is searched, the same rule the interceptor uses.
 */
function hasPdfMagic(head: string): boolean {
    return head.slice(0, PDF_MAGIC_WINDOW).includes(PDF_MAGIC);
}

/**
 * NUL, or enough U+FFFD that the window is mostly replacement characters.
 * No bare count: four bad bytes in a UTF-8 file, or a short GBK sample,
 * must not throw the decode away.
 */
function looksBinary(text: string): boolean {
    if (text.includes("\0")) return true;
    const window = text.slice(0, 4096);
    if (window.length < 16) return false;
    let bad = 0;
    for (const ch of window) if (ch === "\uFFFD") bad++;
    return bad / window.length > 0.02;
}

/**
 * A PDF that reached the text decoder — the interceptor parses PDFs before
 * this, so here the extraction itself failed (encrypted, corrupt, or a
 * structure the parser does not handle). Say that, rather than claiming
 * `read` never extracts PDFs, which is false for every other PDF.
 */
function pdfHint(filePath: string): string {
    const which = filePath ? ` (${JSON.stringify(filePath)})` : "";
    return (
        `This file is a PDF${which}, but its text could not be extracted — ` +
        "it may be encrypted, corrupt, or image-only. " +
        "Do not retry `read` on it or guess the contents from a raw dump."
    );
}

function archiveHint(filePath: string, ext: string, officecliOnPath: () => boolean): string {
    const office = OFFICE_KIND[ext];
    if (office) {
        const which = filePath ? ` (${JSON.stringify(filePath)})` : "";
        const command = filePath
            ? `\`officecli view ${JSON.stringify(filePath)} text\``
            : "the officecli skill";
        const install = officecliOnPath() ? "" : `\n\n${OFFICECLI_MISSING_NOTE}`;
        return `This is a ${office}${which}, not text. Use the officecli skill: ${command}.${install}`;
    }
    const which = filePath ? ` (${JSON.stringify(filePath)})` : "";
    return (
        `This is a ZIP archive${which}, not text. ` +
        "`read` cannot list or extract it. For .docx, .xlsx, or .pptx, use the officecli skill."
    );
}

function genericHint(filePath: string, text: string): string {
    const which = filePath ? ` (${JSON.stringify(filePath)})` : "";
    return (
        `This file is not valid UTF-8 text${which}. ` +
        "`read` did not treat the decode as the file contents. " +
        "It may be a legacy encoding (GBK, Big5, UTF-16) or binary. " +
        "Convert text to UTF-8 with the `shell` tool (`iconv`) and read that file, or use `strings` to inspect bytes.\n" +
        "Unverified decode (truncated):\n" +
        excerpt(text)
    );
}

function excerpt(text: string): string {
    const visible = text.replaceAll("\0", "\\0");
    if (visible.length <= EXCERPT_CHARS) return visible;
    return `${visible.slice(0, EXCERPT_CHARS)}…`;
}
