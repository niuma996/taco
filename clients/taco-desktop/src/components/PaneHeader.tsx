/**
 * PaneHeader — fixed header for a list/detail pane (skills, agents, tools, memory).
 *
 * Owns the left column's top strip: title + count badge on the left, an
 * expandable search box on the right. The box slides out from behind the
 * magnifier button; both share a single bordered control. Everything below the
 * header scrolls independently — the header itself never does.
 *
 * Search is optional: omit `query`/`onQueryChange` and the toggle isn't
 * rendered (e.g. a pane that has nothing to filter yet still gets the header).
 * Extra controls (filter dropdowns, action buttons) slot in via `children`,
 * rendered between the badge and the search box.
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useI18n";
import { TextInput } from "./ui/TextInput";

export interface PaneHeaderProps {
    title: string;
    /**
     * Total number of filterable items. Count only what the query actually
     * filters — a pinned row that always renders (e.g. Memory's global
     * MEMORY.md) must be excluded from both counts, or a query matching nothing
     * still reports "1/n".
     */
    count: number;
    /**
     * How many of `count` survive the current query. Omit when the pane has no
     * filter; the badge then shows `count` alone. With a query active the badge
     * renders `shownCount/count`.
     */
    shownCount?: number;
    query?: string;
    onQueryChange?: (q: string) => void;
    /** Extra controls rendered between the badge and the search box. */
    children?: React.ReactNode;
}

export function PaneHeader({
    title,
    count,
    shownCount,
    query,
    onQueryChange,
    children,
}: PaneHeaderProps) {
    const { t } = useT();
    const searchable = query !== undefined && onQueryChange !== undefined;

    // Search box expands leftward from the magnifier; collapses via Esc or by
    // toggling off, which also clears the query. Auto-focus on open.
    const [searchOpen, setSearchOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (searchOpen) searchRef.current?.focus();
    }, [searchOpen]);
    const closeSearch = () => {
        setSearchOpen(false);
        onQueryChange?.("");
    };

    const filtering = searchable && query.trim() !== "";

    return (
        <div className="pane-header">
            {/* Title + count give way to the search box while searching, so the
                input gets the whole row instead of a cramped corner. */}
            {!searchOpen && (
                <span className="pane-header-title">
                    {title}
                    <span className="pane-count-badge">
                        {filtering && shownCount !== undefined ? `${shownCount}/${count}` : count}
                    </span>
                </span>
            )}
            <span className={`pane-header-actions${searchOpen ? " searching" : ""}`}>
                {children}
                {searchable && (
                    <div className={`pane-search${searchOpen ? " open" : ""}`}>
                        <div
                            className={`pane-search-input-wrap${searchOpen ? " open" : ""}`}
                            aria-hidden={!searchOpen}
                        >
                            <TextInput
                                ref={searchRef}
                                value={query}
                                onChange={(e) => onQueryChange(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") closeSearch();
                                }}
                                placeholder={t("pane.searchPlaceholder")}
                                aria-label={t("pane.searchLabel")}
                                tabIndex={searchOpen ? 0 : -1}
                                className="pane-search-input"
                            />
                        </div>
                        <button
                            type="button"
                            className={`pane-search-toggle${searchOpen ? " active" : ""}`}
                            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                            aria-label={t("pane.searchLabel")}
                            aria-expanded={searchOpen}
                        >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                <circle
                                    cx="7"
                                    cy="7"
                                    r="4.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                                <line
                                    x1="10.5"
                                    y1="10.5"
                                    x2="14"
                                    y2="14"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                        </button>
                    </div>
                )}
            </span>
        </div>
    );
}
