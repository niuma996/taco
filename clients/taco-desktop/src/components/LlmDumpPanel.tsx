/**
 * LLM Dump — topbar chip + floating expanded panel.
 *
 * `LlmDumpChip` is the always-visible entry point in the topbar.
 * `LlmDumpPanel` is the expanded state: bottom-right fixed panel with one
 * `<details>` per turn. Expand/collapse state is lifted to App.tsx.
 */

import { useState } from "react";
import type { LlmDumpEntry } from "../hooks/useLlmDump.ts";
import { useT } from "../i18n/useI18n";
import { Button } from "./ui/Button.tsx";

function formatClock(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface LlmDumpChipProps {
    count: number;
    /** When true, the chip renders even with zero entries so the user has
     *  immediate feedback that debug mode is on. Count badge is suppressed
     *  in that case and a "waiting" hint takes its place. */
    debugMode?: boolean;
    onClick: () => void;
}

/** Topbar inline entry. Mounted whenever debug mode is on or there are
 *  entries — see App.tsx for the gating condition. */
export function LlmDumpChip(props: LlmDumpChipProps) {
    const { t } = useT();
    const waiting = props.count === 0;
    return (
        <button
            type="button"
            className="llm-dump-chip"
            onClick={props.onClick}
            title={
                waiting
                    ? t("debug.showLlmRequestDumpWaiting", {
                          defaultValue: props.debugMode
                              ? "Debug mode is on — dump entries will appear after the next LLM call."
                              : "Open the LLM request dump panel.",
                      })
                    : t("debug.showLlmRequestDump")
            }
        >
            {waiting
                ? t("debug.llmRequestDumpWaiting", {
                      defaultValue: props.debugMode ? "LLM Dump (waiting)" : "LLM Request Dump",
                  })
                : `${t("debug.llmRequestDump")} (${props.count})`}
        </button>
    );
}

export interface LlmDumpPanelProps {
    entries: LlmDumpEntry[];
    onClear: () => void;
    onCollapse: () => void;
}

function entryToText(entry: LlmDumpEntry): string {
    const header = `# === payload ${entry.index} @ ${formatClock(entry.timestamp)} ===`;
    return [header, ...entry.lines].join("\n");
}

export function LlmDumpPanel(props: LlmDumpPanelProps) {
    const { entries, onClear, onCollapse } = props;
    const { t } = useT();
    const [copyState, setCopyState] = useState<"idle" | "done" | "fail">("idle");

    const copyAll = async () => {
        try {
            await navigator.clipboard.writeText(entries.map(entryToText).join("\n\n"));
            setCopyState("done");
            window.setTimeout(() => setCopyState("idle"), 1200);
        } catch {
            setCopyState("fail");
            window.setTimeout(() => setCopyState("idle"), 1500);
        }
    };

    return (
        <aside className="llm-dump-panel" aria-label={t("debug.panel")}>
            <header className="llm-dump-header">
                <strong>
                    {t("debug.llmRequestDump")} ({entries.length})
                </strong>
                <div className="llm-dump-actions">
                    <Button size="sm" variant="ghost" onClick={copyAll}>
                        {copyState === "done"
                            ? t("debug.copied")
                            : copyState === "fail"
                              ? t("debug.copyFailed")
                              : t("debug.copyAll")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onClear}>
                        {t("debug.clear")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onCollapse}
                        aria-label={t("debug.collapsePanel")}
                        title={t("debug.collapse")}
                    >
                        ×
                    </Button>
                </div>
            </header>
            <div className="llm-dump-entries">
                {entries.map((entry, i) => (
                    <details
                        key={entry.timestamp}
                        className="llm-dump-entry"
                        open={i === entries.length - 1}
                    >
                        <summary>
                            #{entry.index} · {formatClock(entry.timestamp)} · {entry.lines.length}{" "}
                            lines
                        </summary>
                        <pre className="llm-dump-pre">{entry.lines.join("\n")}</pre>
                    </details>
                ))}
            </div>
        </aside>
    );
}
