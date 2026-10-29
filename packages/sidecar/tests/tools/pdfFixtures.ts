/**
 * Minimal PDF builders for the read-tool tests.
 *
 * The documents are written by hand rather than shipped as fixtures: a text
 * layer is a page's content stream plus a font resource, and a hand-built
 * file keeps the test readable and the bytes auditable.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** Assemble the numbered objects into a PDF with a cross-reference table. */
function assemble(objects: string[]): Uint8Array {
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
        offsets[i] = out.length;
        out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
}

/**
 * A PDF whose pages carry a text layer.
 *
 * `lines` become one text run per line, so a reader sees them in order.
 */
export function buildTextPdf(lines: string[], pages = 1): Uint8Array {
    const perPage = Math.ceil(lines.length / pages);
    const objects: string[] = [];
    const pageObjectNumbers: number[] = [];

    // 1 catalog, 2 pages tree; then a page + content stream per page.
    for (let p = 0; p < pages; p++) {
        pageObjectNumbers.push(3 + p * 2);
    }
    const fontNumber = 3 + pages * 2;

    const kids = pageObjectNumbers.map((n) => `${n} 0 R`).join(" ");
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);

    for (let p = 0; p < pages; p++) {
        const contentNumber = pageObjectNumbers[p] + 1;
        const chunk = lines.slice(p * perPage, (p + 1) * perPage);
        const stream = chunk
            .map(
                (line, i) =>
                    `BT /F1 12 Tf 72 ${PAGE_HEIGHT - 100 - i * 20} Td (${escapePdfText(line)}) Tj ET`,
            )
            .join("\n");
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
        );
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }

    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    return assemble(objects);
}

/** A PDF whose single page has no text — the shape a scan has. */
export function buildImageOnlyPdf(): Uint8Array {
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R /Resources << >> >>`,
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    return assemble(objects);
}

/** Parentheses and backslashes are the two characters a literal string escapes. */
function escapePdfText(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
