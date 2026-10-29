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

import { normalizeBuiltinToolPath } from "../permissions/workspaceBoundary.ts";
import type { FileError, Result } from "../runtime/pi/node.ts";
import type { Context } from "../runtime/pi/types.ts";
import { getOrThrow } from "../runtime/pi/values.ts";
import { pdfPageCount, readPdfText } from "./pdfRead.ts";
import { loadCanvas, type RenderedPage, renderPdfPages } from "./pdfRender.ts";

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

/** The slice of pi's execution env a read needs. */
interface ReadEnv {
    absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
    readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
}

/**
 * Whether a file is a PDF.
 *
 * The magic decides, not the extension: a `.pdf` that is not a PDF is a
 * different file, and a PDF named `.bin` is still a PDF.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
    const head = bytes.subarray(0, MAGIC_WINDOW);
    // A PDF header may be preceded by junk (some writers prepend bytes), so
    // the magic is looked for inside the window rather than only at offset 0.
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
}

/**
 * Read a PDF.
 *
 * `offset`/`limit` page the text the same way they page any other file, so a
 * long PDF is read in steps rather than flooding the context. A document with
 * no text layer is a scan: its pages are rendered as images instead, so a
 * model that can see images can read it.
 */
export async function readPdf(
    bytes: Uint8Array,
    path: string,
    offset: number | undefined,
    limit: number | undefined,
): Promise<PdfReadResult> {
    const extracted = await readPdfText(bytes);
    if (!("text" in extracted)) {
        // No text layer: the document is a scan, and its pages are the only
        // way to read it.
        if (extracted.noTextLayer) return { ...(await renderScan(bytes, path)), extracted: false };
        return {
            text: `The PDF could not be parsed, so its text was not extracted: ${extracted.reason ?? "unknown error"}`,
            extracted: false,
        };
    }

    const lines = extracted.text.split("\n");
    const start = offset ? Math.max(0, offset - 1) : 0;
    if (start >= lines.length) {
        return {
            text: `Offset ${offset} is beyond end of document (${lines.length} lines total)`,
            extracted: false,
        };
    }
    const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
    const body = lines.slice(start, end).join("\n");

    let text = body;
    if (end < lines.length) {
        text += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
    } else if (start > 0) {
        text += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}.]`;
    }
    text += `\n\n[PDF: ${extracted.totalPages} page(s), text extracted from ${path}.]`;
    return { text, extracted: true };
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
): Promise<{ text: string; images: RenderedPage[] }> {
    const canvas = await loadCanvas();
    if (!canvas) {
        return {
            text:
                "This PDF has no text layer — it is a scan, so its pages are pictures of text. " +
                "Rendering pages to images needs the optional @napi-rs/canvas dependency " +
                "(install it with `pnpm add @napi-rs/canvas@1.0.13`), " +
                "or use `officecli view text` to extract the text.",
            images: [],
        };
    }
    try {
        const totalPages = await pdfPageCount(bytes);
        const pages = Array.from(
            { length: Math.min(totalPages, MAX_RENDERED_PAGES) },
            (_, i) => i + 1,
        );
        const images = await renderPdfPages(bytes, pages, 2, canvas);
        let text = `This PDF has no text layer — it is a scan. Its first ${images.length} page(s) were rendered as images so they can be read.`;
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
    }
}

/**
 * Read the bytes of a path through the tool's execution env.
 *
 * Returns undefined when the path does not resolve or cannot be read — the
 * caller then lets pi produce its own error, which is the message the model
 * already knows how to act on.
 */
export async function readPathBytes(
    env: ReadEnv,
    path: string,
    context: Context,
): Promise<Uint8Array | undefined> {
    try {
        const resolved = getOrThrow(
            await env.absolutePath(normalizeBuiltinToolPath(path), context),
        );
        return getOrThrow(await env.readBinaryFile(resolved, context));
    } catch {
        return undefined;
    }
}
