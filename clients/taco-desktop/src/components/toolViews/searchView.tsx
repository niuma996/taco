/**
 * grep / glob summaries — head shows the pattern, then the scope.
 *
 * Both tools take `{ pattern, path? }`. The default summary probes `path`
 * before any other field, so it showed the search directory and dropped the
 * pattern — the one input that says what the call was looking for. Neither tool
 * has a body override: their output is already a plain list of matches.
 */

import { shortPath, type UiToolCall } from "../../lib/chat/chatUtils";
import { truncate } from "./_util";
import { toolViews } from "./registry";

/**
 * `pattern · path`, or just `pattern` when the search covers the workspace root.
 *
 * Separator rather than a word ("in", "于") so the summary stays pure data and
 * needs no translation, matching the path / command summaries beside it.
 */
function summarizeSearch(tool: UiToolCall): string {
    const args = (tool.args ?? {}) as { pattern?: unknown; path?: unknown };
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (pattern === "") return "";
    const path = typeof args.path === "string" && args.path.length > 0 ? args.path : null;
    const head = truncate(pattern, 60);
    return path === null ? head : `${head} · ${shortPath(path)}`;
}

toolViews.grep = { summary: summarizeSearch };
toolViews.glob = { summary: summarizeSearch };
