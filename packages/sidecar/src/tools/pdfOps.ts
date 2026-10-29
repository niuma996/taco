/**
 * PDF editing: merge, split, fill.
 *
 * Reading a PDF is code in `read` (see pdfRead.ts); these are the operations
 * that produce a new document, so they live here and get their own tools.
 *
 * `pdf-lib` writes the output. It cannot repaginate or reflow — a merged
 * document keeps each source page exactly as it was, and a filled form keeps
 * its layout — which is what "merge these files" and "fill this field" mean.
 */

import { PDFDocument, type PDFField } from "pdf-lib";

/** Why a PDF operation failed. */
export type PdfOpFailure =
    | { kind: "unreadable"; reason: string }
    | { kind: "no_such_page"; page: number; pages: number }
    | { kind: "no_such_field"; field: string }
    | { kind: "field_not_fillable"; field: string; kind_: string }
    | { kind: "empty" };

export type PdfOpResult<T> = { ok: true; value: T } | { ok: false; failure: PdfOpFailure };

/** One page of a source document, as `pdf-lib` counts them (1-based). */
export interface PageSpec {
    /** Which source document the page comes from. */
    readonly source: number;
    /** The page within that document, 1-based. */
    readonly page: number;
}

/**
 * Merge documents into one.
 *
 * `sources` are the documents in order; `pages` picks what goes into the
 * result. A page list of `[1]` for each source, in order, is the common case.
 */
export async function mergePdfs(
    sources: readonly Uint8Array[],
    pages?: readonly PageSpec[],
): Promise<PdfOpResult<Uint8Array>> {
    if (sources.length === 0) return { ok: false, failure: { kind: "empty" } };
    const out = await PDFDocument.create();
    for (const [index, bytes] of sources.entries()) {
        const loaded = await load(bytes);
        if (!loaded.ok) return loaded;
        const doc = loaded.value;
        const wanted = pages?.filter((p) => p.source === index);
        const indices = wanted ? wanted.map((p) => p.page - 1) : range(0, doc.getPageCount());
        for (const pageIndex of indices) {
            // pdf-lib throws on an out-of-range page rather than returning
            // nothing, so the bound is checked before it is asked.
            if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
                return {
                    ok: false,
                    failure: {
                        kind: "no_such_page",
                        page: pageIndex + 1,
                        pages: doc.getPageCount(),
                    },
                };
            }
            const [copied] = await out.copyPages(doc, [pageIndex]);
            out.addPage(copied);
        }
    }
    return { ok: true, value: await out.save() };
}

/**
 * Split one document into several.
 *
 * `ranges` are 1-based page ranges, inclusive at both ends — the shape a
 * reader thinks in ("pages 3 to 7"). The result is one document per range,
 * in the order given.
 */
export async function splitPdf(
    bytes: Uint8Array,
    ranges: readonly { from: number; to: number }[],
): Promise<PdfOpResult<Uint8Array[]>> {
    if (ranges.length === 0) return { ok: false, failure: { kind: "empty" } };
    const loaded = await load(bytes);
    if (!loaded.ok) return loaded;
    const doc = loaded.value;
    const total = doc.getPageCount();
    const out: Uint8Array[] = [];
    for (const range of ranges) {
        if (range.from < 1 || range.to > total || range.from > range.to) {
            return { ok: false, failure: { kind: "no_such_page", page: range.from, pages: total } };
        }
        const part = await PDFDocument.create();
        const indices = [];
        for (let page = range.from; page <= range.to; page++) indices.push(page - 1);
        const copied = await part.copyPages(doc, indices);
        for (const page of copied) part.addPage(page);
        out.push(await part.save());
    }
    return { ok: true, value: out };
}

/** The form fields a document carries, for the model to choose from. */
export interface FormFieldSummary {
    readonly name: string;
    /** "text", "checkbox", "radio", "dropdown" — how the field is filled. */
    readonly type: string;
    readonly value?: string;
}

/** List a document's form fields. */
export async function readFormFields(bytes: Uint8Array): Promise<PdfOpResult<FormFieldSummary[]>> {
    const loaded = await load(bytes);
    if (!loaded.ok) return loaded;
    const form = loaded.value.getForm();
    return {
        ok: true,
        value: form.getFields().map((field) => ({
            name: field.getName(),
            type: fieldType(field),
            value: currentValue(field),
        })),
    };
}

/**
 * Fill a document's form fields.
 *
 * A text field takes a string; a checkbox takes a boolean. Fields the form
 * does not have are an error rather than a silent skip: a form that quietly
 * ignored a name would look filled and be wrong.
 *
 * `flatten` bakes the values into the page content, so the result no longer
 * needs the original form to be readable.
 */
export async function fillPdf(
    bytes: Uint8Array,
    values: Readonly<Record<string, string | boolean>>,
    flatten = true,
): Promise<PdfOpResult<Uint8Array>> {
    const loaded = await load(bytes);
    if (!loaded.ok) return loaded;
    const form = loaded.value.getForm();
    for (const [name, value] of Object.entries(values)) {
        const field = form.getFieldMaybe(name);
        if (!field) {
            return { ok: false, failure: { kind: "no_such_field", field: name } };
        }
        try {
            if (typeof value === "boolean") {
                const box = form.getCheckBox(name);
                if (value) box.check();
                else box.uncheck();
            } else {
                form.getTextField(name).setText(value);
            }
        } catch {
            return {
                ok: false,
                failure: {
                    kind: "field_not_fillable",
                    field: name,
                    kind_: fieldType(field),
                },
            };
        }
    }
    if (flatten) form.flatten();
    return { ok: true, value: await loaded.value.save() };
}

// ─── helpers (internal) ─────────────────────────────────────────────────────

async function load(bytes: Uint8Array): Promise<PdfOpResult<PDFDocument>> {
    try {
        return { ok: true, value: await PDFDocument.load(bytes) };
    } catch (e) {
        return {
            ok: false,
            failure: { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) },
        };
    }
}

/** The page indices `from` to `to`, exclusive of `to`. */
function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i < to; i++) out.push(i);
    return out;
}

/**
 * How a field is filled.
 *
 * pdf-lib gives every field the same base class, so the concrete kind is
 * read off the subclass name — the same names the form API exposes.
 */
function fieldType(field: PDFField): string {
    const kind = field.constructor.name;
    if (kind.includes("CheckBox")) return "checkbox";
    if (kind.includes("RadioGroup")) return "radio";
    if (kind.includes("Dropdown")) return "dropdown";
    if (kind.includes("OptionList")) return "optionlist";
    return "text";
}

function currentValue(field: PDFField): string | undefined {
    const typed = field as unknown as {
        getText?: () => string;
        isChecked?: () => boolean;
    };
    if (typeof typed.getText === "function") return typed.getText();
    if (typeof typed.isChecked === "function") return String(typed.isChecked());
    return undefined;
}
