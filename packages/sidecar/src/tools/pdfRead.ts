/**
 * PDF text extraction for the `read` tool.
 *
 * pi TextDecodes every non-image file, so a PDF arrives as mojibake. unpdf
 * parses the structure instead and returns the document's text layer.
 *
 * Three rules the implementation must keep:
 *
 *  - Always go through `getDocumentProxy` and hand the proxy to `extractText`.
 *    unpdf's raw-bytes path transfers the buffer to the PDF.js worker and
 *    throws `Cannot transfer object of unsupported type` on Node.
 *  - PDF.js takes ownership of the buffer it is given and detaches it, so the
 *    caller's bytes are never handed over directly — a second read of the
 *    same array would fail.
 *  - CMap and standard-font files live next to the bundle. Without them a
 *    CJK document loses characters silently, and a release has no
 *    node_modules to resolve `pdfjs-dist` against.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where PDF.js looks for its CMap / standard-font resources. */
interface PdfJsResources {
    standardFontDataUrl: string;
    cMapPacked: true;
    cMapUrl: string;
}

/**
 * CMap / standard-font directory. The copy is next to the bundle (`lib/pdfjs`),
 * not under `resourceRoot()`: that root is a level above `lib/` in a release,
 * and a miss there drops CJK characters silently. Source runs resolve the
 * installed package instead.
 */
export function pdfJsAssetDir(): string | undefined {
    const cmaps = fileURLToPath(new URL("./pdfjs/cmaps", import.meta.url));
    if (existsSync(cmaps)) return dirname(cmaps);
    return resolvePdfJsDist();
}

/** The installed `pdfjs-dist` package, when it can be found. */
function resolvePdfJsDist(): string | undefined {
    try {
        const require = createRequire(import.meta.url);
        return join(require.resolve("pdfjs-dist/package.json"), "..");
    } catch {
        return undefined;
    }
}

function pdfJsResources(): PdfJsResources | undefined {
    const base = pdfJsAssetDir();
    if (!base) return undefined;
    return {
        standardFontDataUrl: pathToFileURL(join(base, "standard_fonts") + "/").href,
        cMapUrl: pathToFileURL(join(base, "cmaps") + "/").href,
        cMapPacked: true,
    };
}

/** The PDF.js options this module always applies. */
function documentOptions(): Record<string, unknown> {
    const resources = pdfJsResources();
    return {
        disableFontFace: true,
        useSystemFonts: true,
        ...(resources ?? {}),
    };
}

/**
 * Open a document, copying the bytes so the caller's buffer survives.
 *
 * The copy has to happen before the call: PDF.js detaches the buffer it is
 * handed, and a copy taken afterwards throws.
 */
export async function openPdfDocument(bytes: Uint8Array) {
    const { getDocumentProxy } = await import("unpdf");
    return getDocumentProxy(new Uint8Array(bytes), documentOptions());
}

/** Extracted document text, plus what the caller needs to report the result. */
export interface PdfText {
    text: string;
    totalPages: number;
}

/**
 * Extract a PDF's text layer.
 *
 * Returns undefined when the document has no extractable text — a scan, or a
 * drawing-only PDF. The caller decides what to do then; an empty string is
 * not the same as a failed extraction.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText | undefined> {
    const { extractText } = await import("unpdf");
    const proxy = await openPdfDocument(bytes);
    try {
        const { text, totalPages } = await extractText(proxy, { mergePages: true });
        if (text.trim().length === 0) return undefined;
        return { text, totalPages };
    } finally {
        // unpdf only destroys the documents it creates itself; this proxy is
        // ours, so the worker it holds has to be shut down here.
        await proxy.loadingTask.destroy();
    }
}

/** Why a PDF could not be read. */
export interface PdfReadFailure {
    /** True when the document parsed but carries no text. */
    noTextLayer: boolean;
    /** The parser's own message, when it gave one. */
    reason?: string;
}

/**
 * Extract a PDF's text layer, or report why it could not be read.
 *
 * The failure is model-facing: a corrupt or encrypted PDF must not look like
 * an empty document.
 */
export async function readPdfText(bytes: Uint8Array): Promise<PdfText | PdfReadFailure> {
    try {
        const result = await extractPdfText(bytes);
        if (result) return result;
        return { noTextLayer: true };
    } catch (error) {
        return {
            noTextLayer: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
