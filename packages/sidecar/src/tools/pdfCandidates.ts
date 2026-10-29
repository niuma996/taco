/**
 * The PDF editing tools as deferred-tool candidates.
 *
 * Registered alongside the MCP candidates so they appear in the
 * `<deferred_tools>` listing and are loaded on demand via `addTools`. They
 * are not resident: most sessions never touch a PDF, and their schema and
 * description would otherwise cost tokens on every request.
 *
 * The specifier is dynamic so `pdf-lib` — imported by `pdfOps.ts` as soon as
 * `pdfTools.ts` evaluates — is reached on first load, not at startup. The IM
 * file-tool policy is enforced inside the tools (see `refuseInIm`), not here:
 * a candidate is workspace-level, so it cannot know which session will load
 * it.
 */

import type { ToolCandidate } from "../runtime/harness/deferredToolRegistry.ts";

export function pdfToolCandidates(): ToolCandidate[] {
    return [
        {
            name: "pdfMerge",
            summary:
                "Merge PDF files into one. Inputs are taken in order; pass `pages` to pick " +
                "specific pages.",
            loading: "deferred",
            source: "builtin",
            load: async () => (await import("./pdfTools.ts")).createPdfMergeTool(),
        },
        {
            name: "pdfSplit",
            summary: "Split a PDF into one file per page range. Ranges are 1-based and inclusive.",
            loading: "deferred",
            source: "builtin",
            load: async () => (await import("./pdfTools.ts")).createPdfSplitTool(),
        },
        {
            name: "pdfFill",
            summary:
                "Fill a PDF form's fields and write the result. List the fields with " +
                "pdfFields first.",
            loading: "deferred",
            source: "builtin",
            load: async () => (await import("./pdfTools.ts")).createPdfFillTool(),
        },
        {
            name: "pdfFields",
            summary:
                "List a PDF form's fields — names, kinds, and current values. Read-only; " +
                "use before pdfFill.",
            loading: "deferred",
            source: "builtin",
            load: async () => (await import("./pdfTools.ts")).createPdfFieldsTool(),
        },
    ];
}
