/**
 * Region defaults — what a card renders when a tool declares no override.
 *
 * These live beside the registry rather than in ToolCardShell so that every
 * region's default and its override type sit in one place: adding a region means
 * adding a default here and a field on ToolViewSpec, not editing the shell.
 */

import { summarizeToolArgs, type UiToolCall } from "../../lib/chat/chatUtils";
import type { ToolViewProps } from "./registry";

/**
 * Default summary — a one-line digest guessed from well-known argument names
 * (path / command / …), falling back to truncated JSON.
 *
 * Guessing is the right default precisely because it is name-agnostic: a tool
 * this UI has never heard of, including one from an extension or MCP server,
 * still gets a readable head. Tools whose useful input is not one of those
 * fields declare a `summary` instead of widening the guess list.
 */
export function defaultSummary(tool: UiToolCall): string {
    return summarizeToolArgs(tool.name, tool.args);
}

/** Default body — the raw result text, truncated. Tighter while streaming. */
export function DefaultToolBody({ tool }: ToolViewProps) {
    const isRunning = tool.status === "running";
    if (!tool.resultText) return null;
    const cap = isRunning ? 240 : 480;
    const text =
        tool.resultText.length > cap ? `${tool.resultText.slice(0, cap)}…` : tool.resultText;
    return <pre className={`tool-card-result ${isRunning ? "streaming" : ""}`}>{text}</pre>;
}
