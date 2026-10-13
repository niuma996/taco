/**
 * PaneSearch — the magnifier button that slides out into a filter box.
 *
 * Extracted from PaneHeader because SubagentPanel also needs it, but not a
 * whole header: it renders its title through RightPanel's title slot and its
 * search through the actions slot so the button lands immediately left of the
 * close button, exactly like FilesDrawer's folder button.
 *
 * The button owns the open/closed state and reports it upward, since the
 * caller has to give up the row (hide the title) while the box is expanded.
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useI18n";
import { TextInput } from "./ui/TextInput";

export interface PaneSearchProps {
    query: string;
    onQueryChange: (q: string) => void;
    onOpenChange?: (open: boolean) => void;
}

export function PaneSearch({ query, onQueryChange, onOpenChange }: PaneSearchProps) {
    const { t } = useT();
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const setNext = (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    };
    // Closing clears the query so the next open starts from the full list.
    const close = () => {
        setNext(false);
        onQueryChange("");
    };

    return (
        <div className={`pane-search${open ? " open" : ""}`}>
            <div className={`pane-search-input-wrap${open ? " open" : ""}`} aria-hidden={!open}>
                <TextInput
                    ref={inputRef}
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") close();
                    }}
                    placeholder={t("pane.searchPlaceholder")}
                    aria-label={t("pane.searchLabel")}
                    tabIndex={open ? 0 : -1}
                    className="pane-search-input"
                />
            </div>
            <button
                type="button"
                className={`pane-search-toggle${open ? " active" : ""}`}
                onClick={() => (open ? close() : setNext(true))}
                aria-label={t("pane.searchLabel")}
                aria-expanded={open}
            >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="2" />
                    <line
                        x1="10.5"
                        y1="10.5"
                        x2="14"
                        y2="14"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
        </div>
    );
}
