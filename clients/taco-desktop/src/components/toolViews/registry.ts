/**
 * Tool views registry — routes tool names to per-region overrides of the
 * standard tool card.
 *
 * A card has four regions. Two are fixed and two are overridable:
 *
 *   status icon  — ToolCardShell, fixed
 *   tool name    — ToolCardShell, fixed
 *   summary      — a spec's `summary`, else the default field-name digest
 *   body         — a spec's `body`, else ToolCardBody's raw result text
 *
 * The icon and name stay fixed deliberately: they are the anchors that let a
 * long stream of cards be scanned at a glance, and a card drawing its own
 * three-state icon would break that. Open them up only once a second consumer
 * actually needs it.
 *
 * Registration is a side effect: importing a toolViews/* file registers itself
 * into the map. A tool with no entry — or an entry that omits a region — falls
 * back to that region's default, so partial overrides are the normal case.
 */

import type { ReactNode } from "react";
import type { UiToolCall } from "../../lib/chat/chatUtils";

export interface ToolViewProps {
    tool: UiToolCall;
}

/** Body region. null renders no body — the head still carries name / status / summary. */
export type ToolView = (props: ToolViewProps) => React.ReactElement | null;

/**
 * Summary region — the one-line input digest beside the tool name.
 *
 * Returning null suppresses the summary, which is the right answer when the
 * body already renders the same inputs (see agentView). A plain string is the
 * common case; ReactNode is allowed so a summary can carry structure.
 *
 * Not a component: it renders inside the head's existing span and must not own
 * hooks or state, so keeping it a plain function makes that a type error rather
 * than a convention.
 */
export type ToolSummary = (tool: UiToolCall) => ReactNode;

/**
 * Per-region overrides for one tool. Every field is optional — declare only the
 * regions that differ from the default card.
 */
export interface ToolViewSpec {
    summary?: ToolSummary;
    body?: ToolView;
}

/** tool name → region overrides. Unregistered tools use every default. */
export const toolViews: Record<string, ToolViewSpec> = {};

/** Lookup — miss returns undefined and every region falls back to its default. */
export function resolveToolView(name: string): ToolViewSpec | undefined {
    return toolViews[name];
}
