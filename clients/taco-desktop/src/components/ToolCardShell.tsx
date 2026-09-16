/**
 * ToolCardShell — the tool card. Owns every region and resolves each one
 * against the tool's registry entry, falling back to that region's default.
 *
 * Callers pass only extra content (today: the command-permission prompt), so
 * "what regions a card has" is defined here and nowhere else. Which regions are
 * overridable, and why the icon and name are not, is documented on
 * toolViews/registry.
 */

import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useT } from "../i18n/useI18n";
import type { UiToolCall } from "../lib/chat/chatUtils";
import { DefaultToolBody, defaultSummary } from "./toolViews/defaults";
import { resolveToolView } from "./toolViews/registry";

export interface ToolCardShellProps {
    tool: UiToolCall;
    /** Appended below the body; not a region, and not overridable per tool. */
    children?: ReactNode;
}

/** Pretty-printed args, or a bare string when they are not an object. */
function formatRawArgs(args: unknown): string {
    if (args === undefined) return "";
    if (typeof args === "string") return args;
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        // Cyclic or otherwise unserialisable — String() beats showing nothing.
        return String(args);
    }
}

export function ToolCardShell({ tool, children }: ToolCardShellProps) {
    const { t } = useT();
    const [rawOpen, setRawOpen] = useState(false);
    const spec = resolveToolView(tool.name);
    const summary = spec?.summary ? spec.summary(tool) : defaultSummary(tool);
    const Body = spec?.body ?? DefaultToolBody;

    // Every card gets the raw-args toggle, whatever its summary and body chose
    // to show: the digests above are lossy by design, so the exact input the
    // model sent has to stay reachable from the card that sent it.
    const rawArgs = formatRawArgs(tool.args);

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
                {rawArgs !== "" && (
                    <button
                        type="button"
                        className="tool-card-raw-toggle"
                        onClick={() => setRawOpen((v) => !v)}
                        aria-expanded={rawOpen}
                        aria-label={t("activity.toolRawArgs")}
                        title={t("activity.toolRawArgs")}
                    >
                        <ChevronRight
                            size={12}
                            aria-hidden="true"
                            className={`tool-card-raw-chevron ${
                                rawOpen ? "tool-card-raw-chevron--open" : ""
                            }`}
                        />
                    </button>
                )}
            </div>
            {rawOpen && rawArgs !== "" && <pre className="tool-card-raw">{rawArgs}</pre>}
            <Body tool={tool} />
            {children}
        </div>
    );
}
