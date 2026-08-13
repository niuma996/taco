/**
 * edit tool view — git-style diff blocks.
 *
 * Input: `tool.args` = `{ path, edits: [{ oldText, newText }] }`. The array
 * form is supported; other shapes fall back to an "applying edits…" placeholder.
 * Output: `tool.resultText` (e.g. "Applied N edit(s) to path").
 * `tool.details.lines` provides absolute line numbers from the server; missing values
 * fall back to per-edit relative line numbers. No diff library needed — the edits
 * themselves are old→new block pairs.
 */

import { useT } from "../../i18n/useI18n";
import { truncate } from "./_util";
import { type ToolViewProps, toolViews } from "./registry";

interface EditItem {
    oldText: string;
    newText: string;
}

interface EditLineInfo {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}

/** Safely extract the edits array; tolerates missing fields. */
function extractEdits(args: unknown): EditItem[] {
    if (!args || typeof args !== "object") return [];
    const a = args as Record<string, unknown>;
    const raw = a.edits;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((e) => typeof e.oldText === "string" && typeof e.newText === "string")
        .map((e) => ({ oldText: e.oldText as string, newText: e.newText as string }));
}

/**
 * Safely extract the `lines` array from tool.details. Any missing field,
 * length mismatch, or wrong type returns undefined, and the caller falls
 * back to relative line numbers.
 */
export function extractLineInfo(details: unknown, editsLen: number): EditLineInfo[] | undefined {
    if (!details || typeof details !== "object") return undefined;
    const lines = (details as { lines?: unknown }).lines;
    if (!Array.isArray(lines) || lines.length !== editsLen) return undefined;
    const out: EditLineInfo[] = [];
    for (const l of lines) {
        if (!l || typeof l !== "object") return undefined;
        const o = l as Record<string, unknown>;
        if (
            typeof o.oldStart !== "number" ||
            typeof o.oldLines !== "number" ||
            typeof o.newStart !== "number" ||
            typeof o.newLines !== "number"
        ) {
            return undefined;
        }
        out.push({
            oldStart: o.oldStart,
            oldLines: o.oldLines,
            newStart: o.newStart,
            newLines: o.newLines,
        });
    }
    return out;
}

export function EditToolView({ tool }: ToolViewProps) {
    const { t } = useT();
    const edits = extractEdits(tool.args);
    const isRunning = tool.status === "running";
    const lineInfos = extractLineInfo(tool.details, edits.length);
    const useAbsoluteLine = lineInfos !== undefined;

    let totalOldLines = 0;
    let totalNewLines = 0;
    for (const e of edits) {
        totalOldLines += e.oldText.split("\n").length;
        totalNewLines += e.newText.split("\n").length;
    }

    return (
        <>
            {edits.length > 0 && (
                <div className="tool-card-diff" aria-label="edits">
                    <div className="tool-card-diff-summary">
                        <span>
                            {edits.length} edit{edits.length === 1 ? "" : "s"}
                        </span>
                        <span className="tool-card-diff-summary-stat-old">
                            -{totalOldLines} line{totalOldLines === 1 ? "" : "s"}
                        </span>
                        <span className="tool-card-diff-summary-stat-new">
                            +{totalNewLines} line{totalNewLines === 1 ? "" : "s"}
                        </span>
                        {useAbsoluteLine && (
                            <span className="tool-card-diff-summary-absolute">
                                {t("activity.contentAbsolute")}
                            </span>
                        )}
                    </div>
                    {edits.map((e, i) => {
                        const oldLines = e.oldText.split("\n");
                        const newLines = e.newText.split("\n");
                        // Absolute line numbers; falls back to 1 when details are missing.
                        const info = lineInfos?.[i];
                        const oldLineBase = info ? info.oldStart : 1;
                        const newLineBase = info ? info.newStart : 1;
                        return (
                            <div key={`${tool.id}-edit-${i}`} className="tool-card-diff-item">
                                {oldLines.map((line, li) => (
                                    <div
                                        key={`${tool.id}-${i}-o-${li}`}
                                        className="tool-card-diff-old"
                                    >
                                        <span className="tool-card-diff-ln">
                                            {oldLineBase + li}
                                        </span>
                                        <span className="tool-card-diff-mark" aria-hidden="true">
                                            -
                                        </span>
                                        <span className="tool-card-diff-text">
                                            {truncate(line, 200)}
                                        </span>
                                    </div>
                                ))}
                                {newLines.map((line, li) => (
                                    <div
                                        key={`${tool.id}-${i}-n-${li}`}
                                        className="tool-card-diff-new"
                                    >
                                        <span className="tool-card-diff-ln">
                                            {newLineBase + li}
                                        </span>
                                        <span className="tool-card-diff-mark" aria-hidden="true">
                                            +
                                        </span>
                                        <span className="tool-card-diff-text">
                                            {truncate(line, 200)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                </div>
            )}
            {edits.length === 0 && isRunning && (
                <div className="tool-card-diff-empty">applying edits…</div>
            )}
            {tool.resultText && (
                <pre className={`tool-card-result ${isRunning ? "streaming" : ""}`}>
                    {truncate(tool.resultText, 480)}
                </pre>
            )}
        </>
    );
}

toolViews.edit = EditToolView;
