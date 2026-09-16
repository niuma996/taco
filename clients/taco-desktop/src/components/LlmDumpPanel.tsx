/**
 * LLM Dump — floating entry button + expanded panel.
 *
 * `LlmDumpFab` is the always-visible entry point: a translucent icon button
 * floating above the input area. `LlmDumpPanel` is the expanded state: one
 * `<details>` per turn, centered on screen. `LlmDumpDock` owns the open
 * state and the drag positions; App.tsx composes it and hands it to ChatPane
 * as an opaque slot.
 *
 * Dragging: the fab and the panel's header bar are both pointer-draggable.
 * Positions are held per-surface (`fabPos` for the fab, `panelPos` for the
 * panel) so dragging one doesn't move the other. Both default to a
 * CSS-defined anchor (fab: above the input footer; panel: centered on the
 * viewport) and switch to inline `position: fixed + left/top` only after the
 * user actually drags them.
 *
 * Drag vs click: `dragMovedRef` is reset on every pointerdown rather than
 * consumed in the click handler. Consuming it in click means a press that
 * never produces a click (pointer released outside the element) leaves the
 * flag stuck true, and the *next* genuine click gets swallowed — the fab
 * appears to stop responding.
 *
 * Buttons in the panel header stop pointerdown propagation so the header's
 * drag handlers don't `setPointerCapture` on the header. Without that the
 * captured pointer steals the subsequent click and the buttons (especially
 * the close ×) never fire.
 */

import { Bug } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";
import type { LlmDumpEntry } from "../hooks/useLlmDump.ts";
import { useT } from "../i18n/useI18n";
import { Button } from "./ui/Button.tsx";

function formatClock(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Position {
    x: number;
    y: number;
}

interface DragHandlers {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    /** True once the current press has moved far enough to count as a drag. */
    dragMovedRef: React.MutableRefObject<boolean>;
}

export interface LlmDumpFabProps {
    count: number;
    /** null = use the CSS default anchored to the input footer. */
    pos: Position | null;
    dragHandlers: DragHandlers;
    onClick: () => void;
}

/** Translucent floating entry above the input area. Rendered whenever debug
 *  mode is on or there are entries — LlmDumpDock owns the gating. */
export function LlmDumpFab(props: LlmDumpFabProps) {
    const { t } = useT();
    const waiting = props.count === 0;
    const label = waiting
        ? t("debug.showLlmRequestDumpWaiting")
        : `${t("debug.showLlmRequestDump")} (${props.count})`;
    const handleClick = () => {
        // dragMovedRef is reset on pointerdown, so this reads only the press
        // that just ended.
        if (props.dragHandlers.dragMovedRef.current) return;
        props.onClick();
    };
    return (
        <button
            type="button"
            className="llm-dump-fab"
            data-dragged={props.pos !== null}
            onPointerDown={props.dragHandlers.onPointerDown}
            onPointerMove={props.dragHandlers.onPointerMove}
            onPointerUp={props.dragHandlers.onPointerUp}
            onPointerCancel={props.dragHandlers.onPointerUp}
            onClick={handleClick}
            style={
                props.pos
                    ? { position: "fixed", left: `${props.pos.x}px`, top: `${props.pos.y}px` }
                    : undefined
            }
            title={label}
            aria-label={label}
        >
            <Bug size={18} aria-hidden="true" />
            {!waiting && <span className="llm-dump-fab-badge">{props.count}</span>}
        </button>
    );
}

export interface LlmDumpPanelProps {
    entries: LlmDumpEntry[];
    pos: Position | null;
    dragHandlers: DragHandlers;
    onClear: () => void;
    onCollapse: () => void;
}

function entryToText(entry: LlmDumpEntry): string {
    const header = `# === payload ${entry.index} @ ${formatClock(entry.timestamp)} ===`;
    return [header, ...entry.lines].join("\n");
}

type ParsedDumpLine =
    | { kind: "role"; role: string; roleClass: string; index: number | null; body: string }
    | { kind: "plain"; body: string };

/** Split one dump line into role badge + body. sidecar emits `[system] body`
 *  and `[N] role: body`; anything else renders without a badge. Bodies may
 *  contain real newlines (unescaped on receipt), so the patterns use [\s\S]. */
function parseDumpLine(line: string): ParsedDumpLine {
    const system = line.match(/^\[system\] ([\s\S]*)$/);
    if (system) {
        return { kind: "role", role: "system", roleClass: "system", index: null, body: system[1] };
    }
    const msg = line.match(/^\[(\d+)\] ([^:]+): ([\s\S]*)$/);
    if (msg) {
        const role = msg[2];
        return {
            kind: "role",
            role,
            roleClass: role.toLowerCase().replace(/[^a-z]/g, ""),
            index: Number(msg[1]),
            body: msg[3],
        };
    }
    return { kind: "plain", body: line };
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
        <aside
            className="llm-dump-panel"
            data-dragged={props.pos !== null}
            aria-label={t("debug.panel")}
            style={
                props.pos
                    ? { position: "fixed", left: `${props.pos.x}px`, top: `${props.pos.y}px` }
                    : undefined
            }
        >
            {/* Header is the drag handle — pinning drag to the title bar
                keeps the body (collapsible entries + action buttons) free of
                accidental drags. */}
            <header
                className="llm-dump-header"
                onPointerDown={props.dragHandlers.onPointerDown}
                onPointerMove={props.dragHandlers.onPointerMove}
                onPointerUp={props.dragHandlers.onPointerUp}
                onPointerCancel={props.dragHandlers.onPointerUp}
            >
                <strong>
                    {t("debug.llmRequestDump")} ({entries.length})
                </strong>
                <div className="llm-dump-actions">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={copyAll}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {copyState === "done"
                            ? t("debug.copied")
                            : copyState === "fail"
                              ? t("debug.copyFailed")
                              : t("debug.copyAll")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onClear}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {t("debug.clear")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onCollapse}
                        aria-label={t("debug.collapsePanel")}
                        title={t("debug.collapse")}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        ×
                    </Button>
                </div>
            </header>
            <div className="llm-dump-entries">
                {entries.length === 0 ? (
                    <p className="llm-dump-empty">{t("debug.empty")}</p>
                ) : (
                    entries.map((entry, i) => (
                        <details
                            key={entry.timestamp}
                            className="llm-dump-entry"
                            open={i === entries.length - 1}
                        >
                            <summary>
                                #{entry.index} · {formatClock(entry.timestamp)} ·{" "}
                                {entry.lines.length} lines
                            </summary>
                            <div className="llm-dump-lines">
                                {entry.lines.map((line, i) => {
                                    const parsed = parseDumpLine(line);
                                    if (parsed.kind === "plain") {
                                        return (
                                            <div className="llm-dump-line" key={i}>
                                                <pre className="llm-dump-line-body">
                                                    {parsed.body}
                                                </pre>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div
                                            className={`llm-dump-line llm-dump-line--${parsed.roleClass}`}
                                            key={i}
                                        >
                                            <div className="llm-dump-line-head">
                                                <span className="llm-dump-line-role">
                                                    {parsed.role}
                                                </span>
                                                {parsed.index !== null && (
                                                    <span className="llm-dump-line-index">
                                                        #{parsed.index}
                                                    </span>
                                                )}
                                            </div>
                                            <pre className="llm-dump-line-body">{parsed.body}</pre>
                                        </div>
                                    );
                                })}
                            </div>
                        </details>
                    ))
                )}
            </div>
        </aside>
    );
}

export interface LlmDumpDockProps {
    entries: LlmDumpEntry[];
    onClear: () => void;
    /** Renders the fab even with zero entries, so the user sees debug mode is
     *  on before the first LLM call lands. */
    debugMode: boolean;
}

/** Owns the open state, the show/hide gating, and the drag positions shared
 *  between fab and panel. App.tsx composes it and hands it to ChatPane as an
 *  opaque slot, so the view stays unaware of the debug wiring. */
export function LlmDumpDock(props: LlmDumpDockProps) {
    const [open, setOpen] = useState(false);
    const [fabPos, setFabPos] = useState<Position | null>(null);
    const [panelPos, setPanelPos] = useState<Position | null>(null);
    const dragMovedRef = useRef(false);
    const dragRef = useRef<{
        pointerId: number;
        offsetX: number;
        offsetY: number;
        width: number;
        height: number;
    } | null>(null);

    const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        // Reset per press: this press starts as "not a drag" until movement
        // proves otherwise. Doing it here (not in the click handler) is what
        // keeps a click-less press from poisoning the next real click.
        dragMovedRef.current = false;
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        el.setPointerCapture(e.pointerId);
        dragRef.current = {
            pointerId: e.pointerId,
            // Anchor on the current rect (always viewport coordinates) — when
            // the element is still in absolute mode this keeps the first
            // pointer-move from jumping.
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            width: rect.width,
            height: rect.height,
        };
    }, []);

    const onPointerMove = useCallback(
        (e: ReactPointerEvent<HTMLElement>) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            dragMovedRef.current = true;
            const maxX = Math.max(0, window.innerWidth - drag.width);
            const maxY = Math.max(0, window.innerHeight - drag.height);
            const x = Math.min(maxX, Math.max(0, e.clientX - drag.offsetX));
            const y = Math.min(maxY, Math.max(0, e.clientY - drag.offsetY));
            // Route the drag to whichever surface is currently mounted.
            if (open) setPanelPos({ x, y });
            else setFabPos({ x, y });
        },
        [open],
    );

    const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        dragRef.current = null;
    }, []);

    const dragHandlers: DragHandlers = {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        dragMovedRef,
    };

    const handleOpen = useCallback(() => {
        // The panel always re-opens centered (its CSS default) — a position
        // from a previous drag is deliberately not carried over.
        setPanelPos(null);
        setOpen(true);
    }, []);

    const handleCollapse = useCallback(() => {
        setOpen(false);
        // If the fab was dragged somewhere that is no longer on-screen (the
        // window was resized between the drag and this collapse), drop the
        // stored position so it falls back to the CSS anchor instead of
        // rendering off-canvas — which reads as "the icon disappeared".
        setFabPos((prev) => {
            if (!prev) return prev;
            const onScreen =
                prev.x >= 0 &&
                prev.y >= 0 &&
                prev.x <= window.innerWidth &&
                prev.y <= window.innerHeight;
            return onScreen ? prev : null;
        });
    }, []);

    if (!props.debugMode && props.entries.length === 0) return null;
    return open ? (
        <LlmDumpPanel
            pos={panelPos}
            dragHandlers={dragHandlers}
            entries={props.entries}
            onClear={props.onClear}
            onCollapse={handleCollapse}
        />
    ) : (
        <LlmDumpFab
            pos={fabPos}
            dragHandlers={dragHandlers}
            count={props.entries.length}
            onClick={handleOpen}
        />
    );
}
