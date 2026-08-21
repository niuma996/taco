/**
 * ToolCardShell — uniform tool card head (three-state icon + name + summary)
 * with a caller-supplied body.
 *
 * Specialized views in toolViews/* only replace the body; the icon, styling,
 * border, and outer chrome are handled uniformly here.
 */

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { UiToolCall } from "../lib/chatUtils";
import { summarizeToolArgs } from "../lib/chatUtils";

export interface ToolCardShellProps {
    tool: UiToolCall;
    children?: ReactNode;
}

export function ToolCardShell({ tool, children }: ToolCardShellProps) {
    const summary = summarizeToolArgs(tool.name, tool.args);
    const isRunning = tool.status === "running";
    const isError = tool.status === "error";
    const Icon = isRunning ? Loader2 : isError ? XCircle : CheckCircle2;
    const statusClass = isRunning
        ? "tool-card running"
        : isError
          ? "tool-card error"
          : "tool-card ok";
    const iconClass = isRunning
        ? "tool-card-icon tool-card-icon--running"
        : isError
          ? "tool-card-icon tool-card-icon--error"
          : "tool-card-icon tool-card-icon--ok";

    return (
        <div className={statusClass} data-tool-id={tool.id} aria-busy={isRunning}>
            <div className="tool-card-head">
                <Icon
                    size={14}
                    aria-hidden="true"
                    className={`${iconClass} ${isRunning ? "spin" : ""}`.trim()}
                />
                <span className="tool-card-name">{tool.name}</span>
                {summary && <span className="tool-card-summary">{summary}</span>}
            </div>
            {children}
        </div>
    );
}
