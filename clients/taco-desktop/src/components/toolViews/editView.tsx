/**
 * edit tool view — git-style diff blocks.
 *
 * Input: `tool.args` = `{ path, edits: [{ oldText, newText }] }`. The array
 * form is supported; other shapes fall back to a localized "applying edits…".
 * Output: `tool.resultText`, rebuilt through i18n on success — see below.
 *
 * Line numbers are read from `tool.details.patch` — the unified diff the server
 * already computed against the real file. `args.edits` only carries old→new
 * text pairs with no position, so it cannot say *where* a change landed; it
 * renders the fallback block (per-edit relative numbers) until the patch
 * arrives, which is the whole duration of a running call.
 */

import { useT } from "../../i18n/useI18n";
import { truncate } from "./_util";
import { type ToolViewProps, toolViews } from "./registry";

interface EditItem {
    oldText: string;
    newText: string;
}

/** One rendered line of a unified diff. */
export interface UnifiedDiffRow {
    kind: "ctx" | "del" | "add" | "gap";
    /** Line number in the pre-edit file — `del` / `ctx` rows. */
    oldNum?: number;
    /** Line number in the post-edit file — `add` / `ctx` rows. */
    newNum?: number;
    text: string;
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

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into rows carrying real line numbers.
 *
 * Fail-open: anything that isn't a unified diff (missing, empty, a body line
 * outside any hunk) returns undefined and the caller falls back to rendering
 * `args.edits` directly.
 */
export function parseUnifiedPatch(patch: unknown): UnifiedDiffRow[] | undefined {
    if (typeof patch !== "string" || patch.trim() === "") return undefined;
    const rows: UnifiedDiffRow[] = [];
    let oldNum = 0;
    let newNum = 0;
    let inHunk = false;
    // Last old-file line a row consumed — a hunk starting past it skipped lines.
    let lastOld: number | undefined;
    for (const line of patch.split("\n")) {
        const hunk = HUNK_HEADER.exec(line);
        if (hunk) {
            oldNum = Number(hunk[1]);
            newNum = Number(hunk[2]);
            inHunk = true;
            if (lastOld !== undefined && oldNum > lastOld + 1) {
                rows.push({ kind: "gap", text: "" });
            }
            continue;
        }
        // `--- path` / `+++ path` file headers, and the trailing empty line
        // left by the patch's final newline.
        if (!inHunk || line === "") continue;
        if (line.startsWith("\\")) continue; // "\ No newline at end of file"
        const text = line.slice(1);
        if (line.startsWith("-")) {
            rows.push({ kind: "del", oldNum, text });
            lastOld = oldNum;
            oldNum++;
        } else if (line.startsWith("+")) {
            rows.push({ kind: "add", newNum, text });
            newNum++;
        } else if (line.startsWith(" ")) {
            rows.push({ kind: "ctx", oldNum, newNum, text });
            lastOld = oldNum;
            oldNum++;
            newNum++;
        } else {
            return undefined;
        }
    }
    return inHunk ? rows : undefined;
}

/**
 * Row kind → stylesheet class. `del` / `add` map onto the `-old` / `-new`
 * classes the tint rules already use; keep the two in one table so a renamed
 * row kind can't silently fall through to an unstyled class.
 */
export const DIFF_ROW_CLASS: Record<UnifiedDiffRow["kind"], string> = {
    ctx: "tool-card-diff-ctx",
    del: "tool-card-diff-old",
    add: "tool-card-diff-new",
    gap: "tool-card-diff-gap",
};

const DIFF_ROW_MARK: Record<UnifiedDiffRow["kind"], string> = {
    ctx: " ",
    del: "-",
    add: "+",
    gap: "",
};

function readPatch(details: unknown): string | undefined {
    if (!details || typeof details !== "object") return undefined;
    const patch = (details as { patch?: unknown }).patch;
    return typeof patch === "string" ? patch : undefined;
}

export function EditToolView({ tool }: ToolViewProps) {
    const { t } = useT();
    const edits = extractEdits(tool.args);
    const isRunning = tool.status === "running";
    const rows = parseUnifiedPatch(readPatch(tool.details));
    const useAbsoluteLine = rows !== undefined;

    let totalOldLines = 0;
    let totalNewLines = 0;
    if (rows) {
        for (const r of rows) {
            if (r.kind === "del") totalOldLines++;
            else if (r.kind === "add") totalNewLines++;
        }
    } else {
        for (const e of edits) {
            totalOldLines += e.oldText.split("\n").length;
            totalNewLines += e.newText.split("\n").length;
        }
    }

    // The harness phrases success in English ("Successfully replaced N block(s)
    // in path."), and the path is already the card's digest, so rebuild the
    // line from args to follow the UI language. Errors and in-flight calls keep
    // the raw text — there the message itself is the useful part.
    const settled = !isRunning && tool.status !== "error" && edits.length > 0;
    const localizedResult = settled
        ? t("activity.editApplied", { count: edits.length })
        : undefined;

    return (
        <>
            {(rows || edits.length > 0) && (
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
                    {rows
                        ? rows.map((row, i) => {
                              if (row.kind === "gap") {
                                  return (
                                      <div
                                          key={`${tool.id}-gap-${i}`}
                                          className={DIFF_ROW_CLASS.gap}
                                          aria-hidden="true"
                                      >
                                          …
                                      </div>
                                  );
                              }
                              return (
                                  <div
                                      key={`${tool.id}-row-${i}`}
                                      className={DIFF_ROW_CLASS[row.kind]}
                                  >
                                      <span className="tool-card-diff-ln">
                                          {row.kind === "add" ? row.newNum : row.oldNum}
                                      </span>
                                      <span className="tool-card-diff-mark" aria-hidden="true">
                                          {DIFF_ROW_MARK[row.kind]}
                                      </span>
                                      <span className="tool-card-diff-text">
                                          {truncate(row.text, 200)}
                                      </span>
                                  </div>
                              );
                          })
                        : edits.map((e, i) => {
                              const oldLines = e.oldText.split("\n");
                              const newLines = e.newText.split("\n");
                              return (
                                  <div key={`${tool.id}-edit-${i}`} className="tool-card-diff-item">
                                      {oldLines.map((line, li) => (
                                          <div
                                              key={`${tool.id}-${i}-o-${li}`}
                                              className="tool-card-diff-old"
                                          >
                                              <span className="tool-card-diff-ln">{li + 1}</span>
                                              <span
                                                  className="tool-card-diff-mark"
                                                  aria-hidden="true"
                                              >
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
                                              <span className="tool-card-diff-ln">{li + 1}</span>
                                              <span
                                                  className="tool-card-diff-mark"
                                                  aria-hidden="true"
                                              >
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
                <div className="tool-card-diff-empty">{t("activity.editRunning")}</div>
            )}
            {tool.resultText && (
                <pre className={`tool-card-diff-note ${isRunning ? "streaming" : ""}`}>
                    {truncate(localizedResult ?? tool.resultText, 480)}
                </pre>
            )}
        </>
    );
}

// Summary keeps the default: `path` is the useful digest and the diff body
// never repeats it.
toolViews.edit = { body: EditToolView };
