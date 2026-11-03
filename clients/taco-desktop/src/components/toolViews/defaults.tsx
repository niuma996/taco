/**
 * Region defaults — what a card renders when a tool declares no override.
 *
 * These live beside the registry rather than in ToolCardShell so that every
 * region's default and its override type sit in one place: adding a region means
 * adding a default here and a field on ToolViewSpec, not editing the shell.
 */

import { summarizeKnownArgFields, type UiToolCall } from "../../lib/chat/chatUtils";
import type { ToolViewProps } from "./registry";

/**
 * Default summary — a one-line digest read from well-known argument names
 * (path / command / …), or nothing at all.
 *
 * Reading known names is the right default because it is tool-agnostic: a tool
 * this UI has never heard of, including one from an extension or MCP server,
 * gets a readable head for free when its arguments happen to be conventional.
 *
 * When they are not, the head shows only the tool name. It deliberately does
 * NOT fall back to dumping JSON: a truncated `{"listName":"x","tasks":[{"con…`
 * costs the full width of the head and is unreadable at exactly the moment it
 * matters, and the exact arguments now have a proper home — the raw-args
 * disclosure in ToolCardShell, one click away on every card.
 *
 * A tool whose useful input is not a conventional field name should declare a
 * `summary` in its registry entry rather than widen the list read here.
 */
export function defaultSummary(tool: UiToolCall): string {
    return summarizeKnownArgFields(tool.args);
}

/** Default body — the raw result text, truncated. */
export function DefaultToolBody({ tool }: ToolViewProps) {
    const isRunning = tool.status === "running";
    if (!tool.resultText) return null;
    // One cap for both states. A tighter cap while running and a looser one
    // after completion made the block grow a second time the moment the tool
    // finished — a visible jump right after the first one.
    const cap = 480;
    const text =
        tool.resultText.length > cap ? `${tool.resultText.slice(0, cap)}…` : tool.resultText;
    return (
        <pre className={`tool-card-result ${isRunning ? "streaming" : ""} ui-enter`}>{text}</pre>
    );
}
