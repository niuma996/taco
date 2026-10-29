---
name: pdf-edit
description: Use when the user asks to merge, combine, split, cut, extract pages from, or fill in a PDF — merging documents into one, cutting a document into parts, or filling a form's fields. Also use when a PDF has form fields to complete.
metadata:
  version: "1.0.0"
---

# Editing PDFs

Three tools do the work: `pdfMerge`, `pdfSplit`, `pdfFill`. Each takes file paths, writes a new file, and says where it wrote it.

**Read a PDF with the `read` tool.** It returns the text layer; a scanned document has none. Nothing here reads a PDF's content — these tools move pages and set fields.

## Merging

`pdfMerge` takes the inputs in order, and by default every page of every input:

```
pdfMerge({ inputs: ["cover.pdf", "body.pdf"], output: "full.pdf" })
```

Pass `pages` to take specific pages instead. `source` and `page` are both 1-based, and the order of the list is the order of the result:

```
pdfMerge({ inputs: ["a.pdf", "b.pdf"], output: "ab.pdf",
           pages: [{ source: 2, page: 3 }, { source: 1, page: 1 }] })
```

That reads as "page 3 of b.pdf, then page 1 of a.pdf". Check the page counts before picking pages — `read` reports them, and a page that does not exist fails the whole merge.

## Splitting

`pdfSplit` takes 1-based page ranges, inclusive at both ends, and writes one file per range:

```
pdfSplit({ input: "report.pdf", ranges: [{ from: 1, to: 3 }, { from: 4, to: 10 }],
           outputDir: "parts" })
```

The parts are named after the input (`report-1.pdf`, `report-2.pdf`). A range past the end of the document fails the split — read the page count first.

## Filling a form

**List the fields first.** `pdfFields` gives the names, the kinds, and the current values:

```
pdfFields({ input: "form.pdf" })
```

A text field takes a string; a checkbox takes a boolean:

```
pdfFill({ input: "form.pdf", output: "signed.pdf",
          values: { name: "Ada Lovelace", agree: true } })
```

A name the form does not have fails the fill rather than being skipped — a form that quietly ignored a field would look filled and be wrong.

`flatten` defaults to true: the values are baked into the page content, and the result has no editable fields left. Pass `flatten: false` to keep the form fillable, which is what a reviewer needs when they sign it later.

## What these tools do not do

They move pages and set field values. They do not reflow text, edit existing prose, redact content, or change a page's layout — a merged page is the page it was, and a filled field keeps its box.

A PDF whose content needs rewriting is a document to author, not to edit in place.
