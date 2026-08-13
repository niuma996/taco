/**
 * ContextIndicator — topbar context-usage pill.
 *
 * Shows the current session's context usage, ratio, and color band. Click to
 * open a popover with modelId, last-compaction time, and cache-hit stats.
 *
 * Color band follows the compaction threshold:
 *   ratio < threshold → neutral; r ≥ threshold → warn; r > threshold + 0.15 → danger; r > 1 → overflow.
 */

import type { SessionContextInfoResult } from "@taco-ai/protocol";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useI18n.ts";

export interface ContextIndicatorProps {
    info: SessionContextInfoResult | null;
    loading: boolean;
    /** Current compaction threshold; defaults to 0.7. */
    threshold?: number;
    /**
     * Auto-compaction in progress (set from the sidecar's compaction_started push;
     * cleared when compaction finishes). While set, the pill shows a "Compacting"
     * label and pauses numeric refresh to avoid flickering the color band.
     */
    compacting?: boolean;
    className?: string;
}

function bucket(ratio: number, threshold: number): "neutral" | "warn" | "danger" | "overflow" {
    if (ratio > 1) return "overflow";
    if (ratio > threshold + 0.15) return "danger";
    if (ratio >= threshold) return "warn";
    return "neutral";
}

function formatTokens(t: number): string {
    if (t < 1000) return `${t}`;
    if (t < 10_000) return `${(t / 1000).toFixed(1)}k`;
    return `${Math.round(t / 1000)}k`;
}

export function ContextIndicator(props: ContextIndicatorProps) {
    const { info, loading, threshold = 0.7, compacting = false, className } = props;
    const { t } = useT();
    const [popoverOpen, setPopoverOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Close the popover on outside clicks. Use mousedown rather than click to
    // avoid the "open then immediately close" race against the button's
    // onClick in the same event loop tick.
    useEffect(() => {
        if (!popoverOpen) return undefined;
        const onPointerDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setPopoverOpen(false);
            }
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [popoverOpen]);

    const cls = (local: string) => [local, className].filter(Boolean).join(" ");

    if (!info) {
        return (
            <output
                className={cls("topbar-context-indicator topbar-context-indicator--neutral")}
                aria-label={t("context.indicatorLabel")}
            >
                <span className="topbar-context-indicator__pct">—</span>
            </output>
        );
    }

    // `compacting` is a class-only signal here — it does not freeze `ratio`.
    // The "freeze during compaction" UX comes from `useSessionContextInfo`
    // handling `compaction_started` (set compacting, no refresh) and
    // `compaction_finished` (clear compacting, defer refresh to the parent
    // so the toast lands first). Once the parent has toasted and called
    // refresh, the new ratio repaints.
    const ratio = Number.isFinite(info.ratio) ? info.ratio : 0;
    const klass = compacting ? "neutral" : bucket(ratio, threshold);
    const pct = Math.round(ratio * 100);

    // Ring progress (Claude Code-style): SVG ring with the percentage in the
    // center. Radius/circumference drive the stroke-dasharray; clamp to [0,100]
    // to avoid overflow.
    const ringR = 7;
    const ringC = 2 * Math.PI * ringR;
    const ringFill = Math.min(100, Math.max(0, pct)) / 100;

    const hitPct =
        info.cacheHitRatio !== undefined ? `${Math.round(info.cacheHitRatio * 100)}%` : "—";
    const read = info.cacheRead !== undefined ? formatTokens(info.cacheRead) : "—";

    return (
        <div ref={rootRef} className="context-indicator-root">
            <button
                type="button"
                className={cls(
                    `topbar-context-indicator topbar-context-indicator--${klass}${compacting ? " topbar-context-indicator--compacting" : ""}`,
                )}
                aria-label={`${t("context.indicatorLabel")} ${pct}%${compacting ? ` (${t("context.compactingInProgress")})` : ""}`}
                aria-busy={compacting || loading || undefined}
                aria-haspopup="true"
                aria-expanded={popoverOpen}
                onClick={() => setPopoverOpen((v) => !v)}
            >
                <svg
                    className="topbar-context-indicator__ring"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                >
                    {/* Track ring */}
                    <circle
                        className="topbar-context-indicator__ring-track"
                        cx="10"
                        cy="10"
                        r={ringR}
                        fill="none"
                    />
                    {/* Progress ring: starts at 12 o'clock, fills clockwise. */}
                    <circle
                        className="topbar-context-indicator__ring-fill"
                        cx="10"
                        cy="10"
                        r={ringR}
                        fill="none"
                        strokeDasharray={ringC}
                        strokeDashoffset={ringC * (1 - ringFill)}
                        transform="rotate(-90 10 10)"
                    />
                    <text
                        className="topbar-context-indicator__ring-text"
                        x="10"
                        y="10"
                        textAnchor="middle"
                        dominantBaseline="central"
                    >
                        {pct}
                    </text>
                </svg>
                {compacting && (
                    <span className="topbar-context-indicator__compacting-label">
                        {t("context.compacting")}
                    </span>
                )}
            </button>

            {popoverOpen && (
                <output className="context-indicator-popover">
                    <div className="context-indicator-popover__row">
                        {info.modelId} · {info.provider}
                    </div>
                    <div className="context-indicator-popover__row">
                        {formatTokens(info.usedTokens)} / {formatTokens(info.contextWindow)}
                    </div>
                    {info.lastCompactionAt && (
                        <div className="context-indicator-popover__row">
                            {t("context.lastCompaction")}: {info.lastCompactionAt}
                        </div>
                    )}
                    <div className="context-indicator-popover__row context-indicator-popover__row--cache">
                        {t("context.cacheHit", { pct: hitPct, read })}
                    </div>
                    {compacting && (
                        <div className="context-indicator-popover__row context-indicator-popover__row--warn">
                            {t("context.compactingInProgress")}
                        </div>
                    )}
                </output>
            )}
        </div>
    );
}
