/**
 * PaneHeader — fixed header for a list/detail pane (skills, agents, tools, memory).
 *
 * Owns the left column's top strip: title + count badge on the left, an
 * expandable search box on the right (see PaneSearch, shared with
 * SubagentPanel). Everything below the header scrolls independently — the
 * header itself never does.
 *
 * Search is optional: omit `query`/`onQueryChange` and the toggle isn't
 * rendered (e.g. a pane that has nothing to filter yet still gets the header).
 * Extra controls (filter dropdowns, action buttons) slot in via `children`,
 * rendered between the badge and the search box.
 */

import { useState } from "react";
import { PaneSearch } from "./PaneSearch";

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
    const searchable = query !== undefined && onQueryChange !== undefined;

    const [searchOpen, setSearchOpen] = useState(false);

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
                    <PaneSearch
                        query={query}
                        onQueryChange={onQueryChange}
                        onOpenChange={setSearchOpen}
                    />
                )}
            </span>
        </div>
    );
}
