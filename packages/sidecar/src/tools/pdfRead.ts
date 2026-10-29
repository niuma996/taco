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
 *  - `pdfjs-dist` supplies the CMap and standard-font files. Without them a
 *    CJK or non-embedded-font document loses characters silently, so the
 *    resources are located next to the bundle and passed explicitly.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resourceRoot } from "../runtime/runtimeResources.ts";

/** Where PDF.js looks for its CMap / standard-font resources. */
interface PdfJsResources {
    standardFontDataUrl: string;
    cMapPacked: true;
    cMapUrl: string;
}

/**
 * Resources live beside the sidecar bundle, not in node_modules: the desktop
 * release ships `lib/` alone. The copy step puts them in `lib/pdfjs`.
 *
 * The source layout has no such copy, so `pdfjs-dist` is resolved from the
 * installed package instead.
 */
function pdfJsResources(): PdfJsResources | undefined {
    const bundled = join(resourceRoot(), "pdfjs");
    const base = existsSync(bundled) ? bundled : resolvePdfJsDist();
    if (!base) return undefined;
    return {
        standardFontDataUrl: pathToFileURL(join(base, "standard_fonts") + "/").href,
        cMapUrl: pathToFileURL(join(base, "cmaps") + "/").href,
        cMapPacked: true,
    };
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

/** The PDF.js options this module always applies. */
function documentOptions(): Record<string, unknown> {
    const resources = pdfJsResources();
    return {
        disableFontFace: true,
        useSystemFonts: true,
        ...(resources ?? {}),
    };
}

/** Open a document, copying the bytes so the caller's buffer survives. */
async function openDocument(bytes: Uint8Array) {
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
    const proxy = await openDocument(bytes);
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

/** How many pages a document has. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
    const proxy = await openDocument(bytes);
    try {
        return proxy.numPages;
    } finally {
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
