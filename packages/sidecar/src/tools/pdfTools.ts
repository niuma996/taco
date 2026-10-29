/**
 * PDF editing tools: merge, split, fill.
 *
 * Reading a PDF is code in `read`; these produce a new document, so they are
 * tools the model calls. The work itself is in pdfOps.ts — a tool here is
 * the model's way to reach it.
 *
 * Files are read and written through the execution env, so paths resolve the
 * same way they do for `read` and `write`, and the workspace boundary
 * applies unchanged.
 */

import { type Static, Type } from "typebox";
import type { AgentHarnessTool, Context, ExecutionToolContext } from "../runtime/pi/types.ts";
import { getOrThrow } from "../runtime/pi/values.ts";
import { fillPdf, mergePdfs, readFormFields, splitPdf } from "./pdfOps.ts";

export type PdfTool = AgentHarnessTool<ExecutionToolContext>;

/** How many pages a split may produce from one document. */
const MAX_SPLIT_PARTS = 50;

const mergeSchema = Type.Object({
    inputs: Type.Array(Type.String({ description: "Path of a PDF to merge, in order." }), {
        minItems: 1,
        maxItems: 50,
    }),
    output: Type.String({ description: "Path to write the merged PDF to." }),
    pages: Type.Optional(
        Type.Array(
            Type.Object({
                source: Type.Number({ description: "Which input the page comes from, 1-based." }),
                page: Type.Number({ description: "The page within that input, 1-based." }),
            }),
            {
                description:
                    "Which pages go into the result, in order. Omit to take every page of every input.",
            },
        ),
    ),
});

const splitSchema = Type.Object({
    input: Type.String({ description: "Path of the PDF to split." }),
    ranges: Type.Array(
        Type.Object({
            from: Type.Number({ description: "First page of the range, 1-based." }),
            to: Type.Number({ description: "Last page of the range, 1-based, inclusive." }),
        }),
        { minItems: 1, maxItems: MAX_SPLIT_PARTS },
    ),
    outputDir: Type.String({
        description: "Directory to write the parts into. Each part is named after the input.",
    }),
});

const fillSchema = Type.Object({
    input: Type.String({ description: "Path of the PDF form to fill." }),
    output: Type.String({ description: "Path to write the filled PDF to." }),
    values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean()]), {
        description:
            "Field name to value. A boolean fills a checkbox; a string fills a text field.",
    }),
    flatten: Type.Optional(
        Type.Boolean({
            description:
                "Bake the values into the page content (default true). A flattened form has no editable fields left.",
        }),
    ),
});

const fieldsSchema = Type.Object({
    input: Type.String({ description: "Path of the PDF to inspect." }),
});

/** Read a PDF through the execution env, so paths resolve like `read` does. */
async function readPdfFile(
    toolContext: ExecutionToolContext,
    path: string,
    context: Context,
): Promise<Uint8Array> {
    const absolute = getOrThrow(await toolContext.env.absolutePath(path, context));
    return getOrThrow(await toolContext.env.readBinaryFile(absolute, context));
}

/** Write a PDF through the execution env, so it lands where `write` would. */
async function writePdfFile(
    toolContext: ExecutionToolContext,
    path: string,
    bytes: Uint8Array,
    context: Context,
): Promise<void> {
    const absolute = getOrThrow(await toolContext.env.absolutePath(path, context));
    getOrThrow(await toolContext.env.writeFile(absolute, bytes, context));
}

/** A failure, as the model reads it. */
function failureText(failure: { kind: string } & Record<string, unknown>): string {
    switch (failure.kind) {
        case "no_such_page":
            return `That page does not exist: page ${String(failure.page)} of ${String(failure.pages)}.`;
        case "no_such_field":
            return `The form has no field named "${String(failure.field)}". List the fields first.`;
        case "field_not_fillable":
            return `The field "${String(failure.field)}" is a ${String(failure.kind_)} field and cannot take that value.`;
        case "unreadable":
            return `The PDF could not be read: ${String(failure.reason)}`;
        case "empty":
            return "Nothing to do — no input was given.";
        default:
            return `The PDF operation failed: ${failure.kind}`;
    }
}

export function createPdfMergeTool(): PdfTool {
    return {
        name: "pdfMerge",
        label: "pdfMerge",
        description:
            "Merge PDF files into one. Takes the files in order, and by default every page of every file. Returns the path of the merged PDF.",
        parameters: mergeSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Combine PDF files into one document, keeping each page as it was. Use when the user asks to merge, combine, or join PDFs.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: Static<typeof mergeSchema>,
            _onUpdate: unknown,
            toolContext: ExecutionToolContext,
            _invocation: unknown,
            context: Context,
        ) {
            const sources: Uint8Array[] = [];
            for (const input of params.inputs) {
                sources.push(await readPdfFile(toolContext, input, context));
            }
            // The page list is 1-based for the model; pdf-lib counts from 0.
            const pages = params.pages?.map((p) => ({
                source: p.source - 1,
                page: p.page,
            }));
            const merged = await mergePdfs(sources, pages);
            if (!merged.ok) {
                return {
                    content: [{ type: "text", text: failureText(merged.failure) }],
                    details: undefined,
                };
            }
            await writePdfFile(toolContext, params.output, merged.value, context);
            return {
                content: [
                    {
                        type: "text",
                        text: `Merged ${params.inputs.length} file(s) into ${params.output}.`,
                    },
                ],
                details: undefined,
            };
        },
    };
}

export function createPdfSplitTool(): PdfTool {
    return {
        name: "pdfSplit",
        label: "pdfSplit",
        description:
            "Split a PDF into several files by page range. Each range becomes one file in the output directory. Ranges are 1-based and inclusive.",
        parameters: splitSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Cut a PDF into separate files by page range. Use when the user asks to split, extract pages from, or cut a PDF.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: Static<typeof splitSchema>,
            _onUpdate: unknown,
            toolContext: ExecutionToolContext,
            _invocation: unknown,
            context: Context,
        ) {
            const bytes = await readPdfFile(toolContext, params.input, context);
            const parts = await splitPdf(bytes, params.ranges);
            if (!parts.ok) {
                return {
                    content: [{ type: "text", text: failureText(parts.failure) }],
                    details: undefined,
                };
            }
            const stem =
                params.input
                    .split(/[\\/]/)
                    .pop()
                    ?.replace(/\.pdf$/i, "") ?? "part";
            const written: string[] = [];
            for (const [index, part] of parts.value.entries()) {
                const path = `${params.outputDir.replace(/[/\\]+$/, "")}/${stem}-${index + 1}.pdf`;
                await writePdfFile(toolContext, path, part, context);
                written.push(path);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Wrote ${written.length} file(s):\n${written.join("\n")}`,
                    },
                ],
                details: undefined,
            };
        },
    };
}

export function createPdfFillTool(): PdfTool {
    return {
        name: "pdfFill",
        label: "pdfFill",
        description:
            "Fill the form fields of a PDF and write the result. Use the pdfFields tool to list the field names first.",
        parameters: fillSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Fill the form fields of a PDF and write the filled copy. List the fields with pdfFields first, so the values land in the right places.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: Static<typeof fillSchema>,
            _onUpdate: unknown,
            toolContext: ExecutionToolContext,
            _invocation: unknown,
            context: Context,
        ) {
            const bytes = await readPdfFile(toolContext, params.input, context);
            const filled = await fillPdf(bytes, params.values, params.flatten ?? true);
            if (!filled.ok) {
                return {
                    content: [{ type: "text", text: failureText(filled.failure) }],
                    details: undefined,
                };
            }
            await writePdfFile(toolContext, params.output, filled.value, context);
            return {
                content: [
                    {
                        type: "text",
                        text: `Filled ${Object.keys(params.values).length} field(s) into ${params.output}.`,
                    },
                ],
                details: undefined,
            };
        },
    };
}

export function createPdfFieldsTool(): PdfTool {
    return {
        name: "pdfFields",
        label: "pdfFields",
        description:
            "List the form fields of a PDF: their names, their kinds, and their current values. Use this before pdfFill.",
        parameters: fieldsSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "List the form fields of a PDF — names, kinds, and current values. Read-only; use it before pdfFill to get the field names right.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: Static<typeof fieldsSchema>,
            _onUpdate: unknown,
            toolContext: ExecutionToolContext,
            _invocation: unknown,
            context: Context,
        ) {
            const bytes = await readPdfFile(toolContext, params.input, context);
            const fields = await readFormFields(bytes);
            if (!fields.ok) {
                return {
                    content: [{ type: "text", text: failureText(fields.failure) }],
                    details: undefined,
                };
            }
            if (fields.value.length === 0) {
                return {
                    content: [{ type: "text", text: "This PDF has no form fields." }],
                    details: undefined,
                };
            }
            const text = fields.value
                .map((f) => `${f.name} (${f.type})${f.value === undefined ? "" : `: ${f.value}`}`)
                .join("\n");
            return {
                content: [{ type: "text", text }],
                details: undefined,
            };
        },
    };
}

/** Every PDF editing tool, in one barrel. */
export function createPdfTools(): PdfTool[] {
    return [createPdfMergeTool(), createPdfSplitTool(), createPdfFillTool(), createPdfFieldsTool()];
}
