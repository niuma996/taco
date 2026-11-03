/**
 * ToolCardShell — the tool card. Owns every region and resolves each one
 * against the tool's registry entry, falling back to that region's default.
 *
 * Callers pass only extra content (today: the command-permission prompt), so
 * "what regions a card has" is defined here and nowhere else. Which regions are
 * overridable, and why the icon and name are not, is documented on
 * toolViews/registry.
 */

import { ChevronRight, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useT } from "../i18n/useI18n";
import type { UiToolCall } from "../lib/chat/chatUtils";
import { HighlightedCode } from "./HighlightedCode";
import { DefaultToolBody, defaultSummary } from "./toolViews/defaults";
import { resolveToolView } from "./toolViews/registry";
import { IconButton } from "./ui/IconButton";
import { IconSwap } from "./ui/IconSwap";

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
    // model sent has to stay reachable from the card that sent it. Serialized
    // only while open — a long session holds hundreds of collapsed cards, some
    // with file-sized write/edit arguments.
    const hasRawArgs = tool.args !== undefined && tool.args !== "";
    const rawArgs = rawOpen ? formatRawArgs(tool.args) : "";

    const isRunning = tool.status === "running";
    const isError = tool.status === "error";
    const statusClass = isRunning
        ? "tool-card running"
        : isError
          ? "tool-card error"
          : "tool-card ok";

    return (
        <div className={statusClass} data-tool-id={tool.id} aria-busy={isRunning}>
            <div className="tool-card-head">
                {/* The three status icons cross-fade. The spinner carries its
                    rotation only while it is the visible one — a spinner left
                    running behind a faded-out icon would keep burning frames. */}
                <IconSwap
                    className="tool-card-icon"
                    icons={[
                        <LoaderCircle
                            size={14}
                            key="running"
                            aria-hidden="true"
                            className="tool-card-icon--running spin"
                        />,
                        <CircleCheck
                            size={14}
                            key="ok"
                            aria-hidden="true"
                            className="tool-card-icon--ok"
                        />,
                        <CircleX
                            size={14}
                            key="error"
                            aria-hidden="true"
                            className="tool-card-icon--error"
                        />,
                    ]}
                    active={isRunning ? 0 : isError ? 2 : 1}
                />
                <span className="tool-card-name">{tool.name}</span>
                {summary && <span className="tool-card-summary">{summary}</span>}
                {hasRawArgs && (
                    <IconButton
                        size="sm"
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
                    </IconButton>
                )}
            </div>
            {rawOpen && hasRawArgs && (
                <HighlightedCode
                    code={rawArgs}
                    // Non-object args are shown verbatim and are not valid JSON,
                    // so highlighting them as JSON would mis-tokenise.
                    lang={typeof tool.args === "object" ? "json" : "text"}
                    className="tool-card-raw"
                />
            )}
            <Body tool={tool} />
            {children}
        </div>
    );
}
