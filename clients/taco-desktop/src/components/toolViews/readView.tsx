/**
 * read tool view — line count instead of file content.
 *
 * A successful read dumps the whole file into `resultText`, which drowns the
 * chat stream. The card shows how many lines came back plus a button that opens
 * the file in the shared preview popup (the same surface the file tree uses).
 * Failures keep the raw text: the error message is the useful part.
 */

import { FileText } from "lucide-react";
import type { ReactElement } from "react";
import { useFilePreviewOpener } from "../../hooks/useFilePreviewOpener";
import { useT } from "../../i18n/useI18n";
import { truncate } from "./_util";
import { type ToolViewProps, toolViews } from "./registry";

/** `[Showing lines 1-2000 of 5000. …]` / `[Line 3 is 60KB, exceeds …]` — appended by the tool, not file content. */
const TRUNCATION_NOTE_RE = /\n*\[(?:Showing lines |Line \d+ is |\d+ more lines in file)[^\]]*\]$/;

/** Text-part payload of a `read` whose target was an image. */
const IMAGE_RESULT_RE = /^Read image file \[/;

/**
 * Lines the model actually received. The tool's trailing truncation note is
 * dropped first so it doesn't inflate the count, and a trailing newline is not
 * a line of its own.
 */
export function countReadLines(resultText: string): number {
    const body = resultText.replace(TRUNCATION_NOTE_RE, "");
    if (body === "") return 0;
    const withoutTrailingNewline = body.endsWith("\n") ? body.slice(0, -1) : body;
    return withoutTrailingNewline.split("\n").length;
}

export function ReadToolView({ tool }: ToolViewProps): ReactElement | null {
    const { t } = useT();
    const opener = useFilePreviewOpener();
    const args = (tool.args ?? {}) as { path?: unknown };
    const path = typeof args.path === "string" ? args.path : "";
    const resultText = tool.resultText ?? "";

    // Errors and in-flight calls keep the existing raw-text rendering. A card
    // expired by expireUnresolvedToolCalls is "error" with no resultText —
    // rendering the <pre> then leaves an empty box, so fall through to nothing.
    if (tool.status === "error") {
        if (resultText.length === 0) return null;
        return <pre className="tool-card-result">{truncate(resultText, 480)}</pre>;
    }
    if (tool.status === "running") {
        return <div className="tool-card-read-status">{t("activity.readRunning")}</div>;
    }

    const isImage = IMAGE_RESULT_RE.test(resultText);
    const summary = isImage
        ? t("activity.readImage")
        : t("activity.readLines", { count: countReadLines(resultText) });

    return (
        <div className="tool-card-read">
            <span className="tool-card-read-status">{summary}</span>
            {opener !== null && path.length > 0 && (
                <button
                    type="button"
                    className="tool-card-read-open"
                    onClick={() => opener.openPreview(path)}
                    aria-label={t("activity.readOpenFile")}
                    title={t("activity.readOpenFile")}
                >
                    <FileText size={13} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

// Summary keeps the default `path` digest — the body shows a line count, not
// the path, so the two do not overlap.
toolViews.read = { body: ReadToolView };
