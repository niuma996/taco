#!/usr/bin/env node

/**
 * Copy the PDF.js font resources next to a sidecar bundle.
 *
 * PDF.js needs a CMap per character collection and the standard-font files to
 * decode a document's text. Without them a CJK PDF loses its characters
 * silently — the pages render, the text comes back empty.
 *
 * They are copied rather than bundled: they are looked up by URL at runtime,
 * and the desktop release ships `lib/` alone, with no node_modules to resolve
 * `pdfjs-dist` against.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Copy the PDF.js resources into `libDir/pdfjs`.
 *
 * The destination is cleared first so a removed resource does not linger.
 */
export function copyPdfJsAssets(libDir) {
    const require = createRequire(import.meta.url);
    const destination = join(libDir, "pdfjs");
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });

    const base = join(require.resolve("pdfjs-dist/package.json"), "..");
    for (const dir of ["cmaps", "standard_fonts"]) {
        cpSync(join(base, dir), join(destination, dir), { recursive: true });
    }
    cpSync(join(base, "LICENSE"), join(destination, "LICENSE.pdfjs-dist"));
}
