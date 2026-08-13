import type { TableHTMLAttributes } from "react";

/**
 * Wraps a GFM table in a horizontally-scrollable container so a wide table
 * scrolls in place instead of widening the assistant message and pushing a
 * scrollbar onto the chat pane. `min-width: 0` on the wrapper lets the flex
 * column shrink; the table inside keeps its intrinsic width and overflows.
 */
export function ScrollableTable(props: TableHTMLAttributes<HTMLTableElement>) {
    return (
        <div className="md-table-scroll">
            <table {...props} />
        </div>
    );
}
