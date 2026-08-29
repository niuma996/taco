/**
 * Tool views registry — routes tool names to their specialized view component.
 *
 * Registration is a side effect: importing a toolViews/* file registers itself
 * into the map. `Message` resolves by tool.name and falls back to ToolCardBody on miss.
 * Five built-in tools today; the registry map is sufficient without over-abstracting.
 */

import type { UiToolCall } from "../../lib/chat/chatUtils";

export interface ToolViewProps {
    tool: UiToolCall;
}

export type ToolView = (props: ToolViewProps) => React.ReactElement;

/** tool name → specialized view component. Unregistered tools fall through. */
export const toolViews: Record<string, ToolView> = {};

/** Lookup — hit returns the view; miss returns undefined (Message decides the fallback). */
export function resolveToolView(name: string): ToolView | undefined {
    return toolViews[name];
}
