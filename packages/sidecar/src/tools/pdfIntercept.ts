/**
 * PDF interception for the `read` tool.
 *
 * pi's read decodes every non-image file as UTF-8, so a PDF comes back as
 * mojibake. This module recognises the PDF magic and reads the document
 * properly instead: its text layer when it has one, and the pages as images
 * when it does not.
 *
 * The interception happens before pi's own read, so the bytes never reach the
 * decoder: the result is real text, paginated with the same offset/limit
 * semantics as any other file.
 */

import { open } from "node:fs/promises";

import { normalizeBuiltinToolPath } from "../permissions/workspaceBoundary.ts";
import type { FileError, Result } from "../runtime/pi/node.ts";
import type { Context } from "../runtime/pi/types.ts";
import { getOrThrow } from "../runtime/pi/values.ts";
import { openPdfDocument, readPdfText } from "./pdfRead.ts";
import {
    canvasInstallCommand,
    loadCanvas,
    type RenderedPage,
    renderPdfPages,
} from "./pdfRender.ts";

/** The bytes every PDF starts with. */
const PDF_MAGIC = "%PDF-";

/** Enough of the head to recognise a PDF without reading the whole file. */
const MAGIC_WINDOW = 1024;

/**
 * How many pages to rasterise when a document has no text layer.
 *
 * Each page becomes an image in the conversation, so the bound is what keeps
 * a long scan from costing more context than the conversation can carry.
 */
const MAX_RENDERED_PAGES = 5;

/**
 * pi's read caps a file at 2000 lines / 50KB even when `limit` is omitted.
 * The PDF path has to do the same, or an omitted limit returns the document.
 */
const PDF_MAX_LINES = 2000;
const PDF_MAX_BYTES = 50 * 1024;
/** `formatSize(50 * 1024)` in pi's truncation note. */
const PDF_BYTE_LIMIT_LABEL = "50.0KB";

/** The slice of pi's execution env a read needs. */
interface ReadEnv {
    absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
    readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
}

/**
 * Whether a file is a PDF.
 *
 * The magic decides, not the extension: a `.pdf` that is not a PDF is a
 * different file, and a PDF named `.bin` is still a PDF. The header may sit
 * inside the first 1024 bytes — the spec allows a preamble — so the magic is
 * looked for in that window rather than only at offset 0.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
    const head = bytes.subarray(0, MAGIC_WINDOW);
    const magic = new TextEncoder().encode(PDF_MAGIC);
    outer: for (let i = 0; i <= head.length - magic.length; i++) {
        for (let j = 0; j < magic.length; j++) {
            if (head[i + j] !== magic[j]) continue outer;
        }
        return true;
    }
    return false;
}

/** A PDF read, resolved to what the model should see. */
export interface PdfReadResult {
    /** The document's text, or the reason it could not be read. */
    text: string;
    /** True when `text` is extracted content rather than an explanation. */
    extracted: boolean;
    /** Pages rasterised for a document with no text layer. */
    images?: RenderedPage[];
    /** Set when the caller should read the file as text instead of using `text`. */
    fallback?: boolean;
}

/**
 * Read a PDF.
 *
 * `offset`/`limit` page the extracted lines the same way they page any other
 * file. An omitted or oversized `limit` is still capped, so a long document
 * does not flood the context. Those parameters are line offsets, not page
 * numbers: a scan renders its first pages and says how many were left out.
 */
export async function readPdf(
    bytes: Uint8Array,
    path: string,
    offset: number | undefined,
    limit: number | undefined,
): Promise<PdfReadResult> {
    const extracted = await readPdfText(bytes);
    if (!("text" in extracted)) {
        if (extracted.noTextLayer) return { ...(await renderScan(bytes, path)), extracted: false };
        return {
            text: `The PDF could not be parsed, so its text was not extracted: ${extracted.reason ?? "unknown error"}`,
            extracted: false,
            // A mention of the header is not a document. Falling through keeps
            // the original text; replacing it with this error destroys the file.
            fallback: true,
        };
    }

    const lines = extracted.text.split("\n");
    const paged = pagePdfText(lines, offset, limit);
    if (!paged.extracted) return paged;
    return {
        text: `${paged.text}\n\n[PDF: ${extracted.totalPages} page(s), text extracted from ${path}.]`,
        extracted: true,
    };
}

function pagePdfText(
    lines: string[],
    offset: number | undefined,
    limit: number | undefined,
): PdfReadResult {
    const start = offset ? Math.max(0, offset - 1) : 0;
    if (start >= lines.length) {
        return {
            text: `Offset ${offset} is beyond end of document (${lines.length} lines total)`,
            extracted: false,
        };
    }

    const userEnd = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
    const capEnd = Math.min(userEnd, start + PDF_MAX_LINES);
    const selected: string[] = [];
    let bytes = 0;
    let stoppedForBytes = false;
    let truncatedFirstLine = false;

    for (let i = start; i < capEnd; i++) {
        const line = lines[i] ?? "";
        const lineBytes = Buffer.byteLength(line, "utf8");
        const separator = selected.length > 0 ? 1 : 0;
        if (bytes + separator + lineBytes > PDF_MAX_BYTES) {
            if (selected.length === 0) {
                selected.push(truncateUtf8(line, PDF_MAX_BYTES));
                truncatedFirstLine = true;
            }
            stoppedForBytes = true;
            break;
        }
        selected.push(line);
        bytes += separator + lineBytes;
    }

    const end = start + selected.length;
    const body = selected.join("\n");
    return {
        text: body + continuationNote(lines, start, end, stoppedForBytes, truncatedFirstLine),
        extracted: true,
    };
}

function continuationNote(
    lines: string[],
    start: number,
    end: number,
    stoppedForBytes: boolean,
    truncatedFirstLine: boolean,
): string {
    if (truncatedFirstLine) {
        const more = end < lines.length ? ` Use offset=${end + 1} to continue.` : "";
        return `\n\n[Line ${start + 1} exceeds the ${PDF_BYTE_LIMIT_LABEL} limit and was truncated.${more}]`;
    }
    if (stoppedForBytes) {
        return `\n\n[Showing lines ${start + 1}-${end} of ${lines.length} (${PDF_BYTE_LIMIT_LABEL} limit). Use offset=${end + 1} to continue.]`;
    }
    if (end < lines.length) {
        return `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
    }
    if (start > 0) return `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}.]`;
    return "";
}

/** Cut to a byte budget without splitting a UTF-8 code point. */
function truncateUtf8(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes) return text;
    // `maxBytes` may land inside a code point. Walk back to its lead byte and
    // exclude it; a continuation byte is 10xxxxxx.
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8");
}

/**
 * Rasterise the pages of a PDF that has no text layer.
 *
 * The pages come back empty when they could not be rendered — the optional
 * canvas dependency is missing, or the document is broken. The text says
 * which, so the model knows whether to try another route.
 */
export async function renderScan(
    bytes: Uint8Array,
    path: string,
    load: () => Promise<Awaited<ReturnType<typeof loadCanvas>>> = loadCanvas,
): Promise<{ text: string; images: RenderedPage[] }> {
    const canvas = await load();
    if (!canvas) {
        return {
            text:
                "This PDF has no text layer — it is a scan, so its pages are pictures of text. " +
                "Rendering those pages needs the optional @napi-rs/canvas package, which this install does not have. " +
                `Install it with \`${canvasInstallCommand()}\`. ` +
                "There is no text layer to extract.",
            images: [],
        };
    }
    let proxy: Awaited<ReturnType<typeof openPdfDocument>> | undefined;
    try {
        proxy = await openPdfDocument(bytes);
        const totalPages = proxy.numPages;
        const pages = Array.from(
            { length: Math.min(totalPages, MAX_RENDERED_PAGES) },
            (_, i) => i + 1,
        );
        const images = await renderPdfPages(proxy, pages, 2, canvas);
        let text = `This PDF has no text layer — it is a scan. Its first ${images.length} page(s) were rendered as images.`;
        if (totalPages > images.length) {
            text += ` The document has ${totalPages} pages; only the first ${images.length} were rendered.`;
        }
        text += `\n\n[PDF: rendered from ${path}.]`;
        return { text, images };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            text: `This PDF has no text layer and its pages could not be rendered: ${reason}`,
            images: [],
        };
    } finally {
        await proxy?.loadingTask.destroy();
    }
}

/**
 * Read a PDF's bytes, or undefined when the path is not a PDF.
 *
 * Returns undefined when the path does not resolve or cannot be read — the
 * caller then lets pi produce its own error, which is the message the model
 * already knows how to act on. A non-PDF is not read here: the env has no
 * ranged read, so the magic is checked with a probe of the path
 * `absolutePath` already resolved. That probe is not a permission gate —
 * `readBinaryFile` is a plain read of the same path — and it keeps a text
 * file from being loaded twice.
 */
export async function readPdfBytes(
    env: ReadEnv,
    path: string,
    context: Context,
): Promise<Uint8Array | undefined> {
    let resolved: string;
    try {
        resolved = getOrThrow(await env.absolutePath(normalizeBuiltinToolPath(path), context));
    } catch {
        return undefined;
    }
    const head = await readHead(resolved);
    if (!head || !isPdfBytes(head)) return undefined;
    try {
        return getOrThrow(await env.readBinaryFile(resolved, context));
    } catch {
        return undefined;
    }
}

async function readHead(path: string): Promise<Uint8Array | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(path, "r");
        const buf = Buffer.alloc(MAGIC_WINDOW);
        const { bytesRead } = await handle.read(buf, 0, MAGIC_WINDOW, 0);
        return buf.subarray(0, bytesRead);
    } catch {
        return undefined;
    } finally {
        await handle?.close();
    }
}
