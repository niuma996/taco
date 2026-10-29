/**
 * The MIME type a file name implies.
 *
 * Only a hint: the bytes decide when the two disagree, because a renamed
 * file is still the format its content says it is. The name matters anyway —
 * it is what the model reads, and an extension is how a reader knows what
 * it is holding.
 */
export function guessMimeType(name: string): string {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const known: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
        zip: "application/zip",
    };
    return known[ext] ?? "application/octet-stream";
}
