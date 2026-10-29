/**
 * Render a PDF page as an image, for a model that can see images.
 *
 * A scanned document has no text layer: its pages are pictures of text. The
 * only way to get them into a conversation is to rasterise them and hand the
 * result over as image content.
 *
 * Rasterising needs `@napi-rs/canvas` — a native binary, 30-40MB per
 * platform. It is therefore an optional dependency: without it this module
 * reports that rendering is unavailable rather than failing the read.
 */

/** How the canvas dependency is loaded, so tests can supply their own. */
export type CanvasLoader = () => Promise<typeof import("@napi-rs/canvas")>;

/**
 * Load the optional canvas dependency.
 *
 * Returns undefined when it is not installed — the caller then falls back to
 * text extraction instead of rendering.
 */
export async function loadCanvas(): Promise<Awaited<ReturnType<CanvasLoader>> | undefined> {
    try {
        return await import("@napi-rs/canvas");
    } catch {
        return undefined;
    }
}

/** One page rendered to a PNG, ready to be sent as image content. */
export interface RenderedPage {
    /** 1-based page number, as the document numbers them. */
    page: number;
    /** Base64-encoded PNG. */
    data: string;
    mimeType: "image/png";
}

/**
 * Render the pages of a PDF to PNGs.
 *
 * `maxPages` bounds the work: a 200-page scan rendered in full would cost
 * more context than the conversation can carry.
 */
export async function renderPdfPages(
    bytes: Uint8Array,
    pages: number[],
    scale: number,
    canvas: Awaited<ReturnType<CanvasLoader>>,
): Promise<RenderedPage[]> {
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    // PDF.js takes ownership of the buffer it is handed and detaches it.
    const proxy = await getDocumentProxy(new Uint8Array(bytes));
    try {
        const rendered: RenderedPage[] = [];
        for (const page of pages) {
            const png = await renderPageAsImage(proxy, page, {
                scale,
                canvasImport: () => Promise.resolve(canvas),
            });
            rendered.push({
                page,
                data: Buffer.from(png).toString("base64"),
                mimeType: "image/png",
            });
        }
        return rendered;
    } finally {
        await proxy.loadingTask.destroy();
    }
}
