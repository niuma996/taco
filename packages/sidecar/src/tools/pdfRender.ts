/**
 * Render a PDF page as an image, for a model that can see images.
 *
 * A scanned document has no text layer: its pages are pictures of text. The
 * only way to get them into a conversation is to rasterise them and hand the
 * result over as image content.
 *
 * Rasterising needs `@napi-rs/canvas`, a native binary of 30-40MB per
 * platform, so it stays optional and is not bundled. A release has no
 * node_modules beside the bundle; the package is loaded from
 * `$TACO_HOME/vendor` when it is not otherwise resolvable.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { tacoHome } from "../config/tacoHome.ts";

/** Must match `optionalDependencies` in package.json. */
const CANVAS_PACKAGE = "@napi-rs/canvas";
const CANVAS_VERSION = "1.0.13";

/** How the canvas dependency is loaded, so tests can supply their own. */
export type CanvasLoader = () => Promise<typeof import("@napi-rs/canvas")>;

type CanvasModule = Awaited<ReturnType<CanvasLoader>>;

/** Install command for a release, which has no node_modules beside the bundle. */
export function canvasInstallCommand(): string {
    return `npm install --prefix "${join(tacoHome(), "vendor")}" ${CANVAS_PACKAGE}@${CANVAS_VERSION}`;
}

async function importInstalledCanvas(): Promise<unknown> {
    return import("@napi-rs/canvas");
}

/**
 * Load the optional canvas dependency.
 *
 * The package import works in a dev install. A release bundle cannot resolve
 * it — esbuild leaves the import external, and the app ships no node_modules —
 * so the fallback is the same `$TACO_HOME/vendor` prefix other native SDKs use.
 * Canvas is CJS with a native binding, so that fallback uses `require`.
 */
export async function loadCanvas(
    importCanvas: () => Promise<unknown> = importInstalledCanvas,
): Promise<CanvasModule | undefined> {
    try {
        const loaded = await importCanvas();
        if (loaded) return loaded as CanvasModule;
    } catch {
        // Not installed where the bundle can resolve it.
    }
    return loadCanvasFromVendor();
}

function loadCanvasFromVendor(): CanvasModule | undefined {
    const root = join(tacoHome(), "vendor");
    const entry = join(root, "node_modules", "@napi-rs", "canvas", "index.js");
    if (!existsSync(entry)) return undefined;
    try {
        // createRequire resolves from this file's directory even when the
        // package.json is absent; the vendor tree is what has to exist.
        const req = createRequire(join(root, "package.json"));
        return req(CANVAS_PACKAGE) as CanvasModule;
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

type OpenedPdf = Parameters<typeof import("unpdf").renderPageAsImage>[0];

/**
 * Render already-open pages to PNGs.
 *
 * The caller opens the document (so the CMap options are applied) and destroys
 * it. Opening here would drop those options: this function is handed a proxy,
 * and a second open from raw bytes does not receive them.
 */
export async function renderPdfPages(
    proxy: OpenedPdf,
    pages: number[],
    scale: number,
    canvas: CanvasModule,
): Promise<RenderedPage[]> {
    const { renderPageAsImage } = await import("unpdf");
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
}
