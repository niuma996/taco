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
    | { kind: "no_such_page"; page: number; pages: number; source?: number }
    | { kind: "no_such_field"; field: string }
    | { kind: "field_not_fillable"; field: string; kind_: string }
    | { kind: "empty" };

export type PdfOpResult<T> = { ok: true; value: T } | { ok: false; failure: PdfOpFailure };

/** A merged document, and how many pages it holds. */
export interface MergedPdf {
    readonly bytes: Uint8Array;
    readonly pageCount: number;
}

/**
 * One page to copy.
 *
 * `source` is 0-based — the tool subtracts 1 before calling, because the
 * model counts inputs from 1. `page` is 1-based.
 */
export interface PageSpec {
    /** Which source document, 0-based. */
    readonly source: number;
    /** The page within that document, 1-based. */
    readonly page: number;
}

/**
 * Merge documents into one.
 *
 * Omit `pages` to take every page of every source, sources in order. A
 * page list is copied in the order given, not grouped by source.
 */
export async function mergePdfs(
    sources: readonly Uint8Array[],
    pages?: readonly PageSpec[],
): Promise<PdfOpResult<MergedPdf>> {
    if (sources.length === 0) return { ok: false, failure: { kind: "empty" } };
    const docs: PDFDocument[] = [];
    for (const bytes of sources) {
        const loaded = await load(bytes);
        if (!loaded.ok) return loaded;
        docs.push(loaded.value);
    }
    const picked =
        pages ??
        docs.flatMap((doc, source) =>
            range(1, doc.getPageCount() + 1).map((page) => ({ source, page })),
        );
    const out = await PDFDocument.create();
    for (const spec of picked) {
        const doc = docs[spec.source];
        // A source past the end is a failed merge, not a shorter document.
        if (!doc) {
            return {
                ok: false,
                failure: { kind: "no_such_page", page: spec.page, pages: 0, source: spec.source },
            };
        }
        const pageIndex = spec.page - 1;
        // pdf-lib throws on an out-of-range page rather than returning
        // nothing, so the bound is checked before it is asked.
        if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
            return {
                ok: false,
                failure: {
                    kind: "no_such_page",
                    page: spec.page,
                    pages: doc.getPageCount(),
                    source: spec.source,
                },
            };
        }
        const [copied] = await out.copyPages(doc, [pageIndex]);
        out.addPage(copied);
    }
    return { ok: true, value: { bytes: await out.save(), pageCount: out.getPageCount() } };
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
        const illegal = offendingPage(range, total);
        if (illegal !== undefined) {
            return { ok: false, failure: { kind: "no_such_page", page: illegal, pages: total } };
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

/**
 * The bound that makes a range illegal, or undefined when the range fits.
 *
 * Reporting `from` when `to` is the one past the end sends the model back
 * to a page that exists.
 */
function offendingPage(range: { from: number; to: number }, total: number): number | undefined {
    if (range.from < 1 || range.from > total) return range.from;
    if (range.to > total) return range.to;
    if (range.from > range.to) return range.from;
    return undefined;
}

/** The page numbers `from` to `to`, exclusive of `to`. */
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
