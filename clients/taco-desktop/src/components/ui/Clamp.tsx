/**
 * Clamp — long text collapsed to `lines` lines with an ellipsis, expanding in
 * place when clicked.
 *
 * The toggle only appears when the text actually overflows. A clamped box
 * reports its truncated height as both scrollHeight and clientHeight, so the
 * usual `scrollHeight > clientHeight` test never fires; the measurement here
 * lifts the clamp to read the full height, then restores it to read the
 * visible one.
 *
 * The cap is applied from the first layout, before anything is known about
 * overflow; the toggle only appears once the text turns out to overflow. The
 * two cannot be linked, or the measurement would compare an uncapped box
 * against itself.
 *
 * No labels: the button's own text is its label, so this stays free of i18n
 * coupling (`ui/` has no locale).
 */

import {
    type CSSProperties,
    type ReactElement,
    type ReactNode,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

export interface ClampProps {
    children: ReactNode;
    /** Visible lines while collapsed. */
    lines?: number;
    /** Applied to the wrapper, which is the <button> when the text overflows. */
    className?: string;
}

export function Clamp({ children, lines = 5, className }: ClampProps): ReactElement {
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const textRef = useRef<HTMLDivElement>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — the body reads neither `children` nor `lines`, but a streaming text update or a changed line budget must re-measure whether the toggle is still needed.
    useLayoutEffect(() => {
        // Skip while expanded: with the clamp lifted the two heights match, and
        // re-measuring would drop `overflowing` and unmount the toggle mid-read.
        if (expanded) return;
        const el = textRef.current;
        if (!el) return;
        const previous = el.style.webkitLineClamp;
        el.style.webkitLineClamp = "unset";
        const full = el.scrollHeight;
        el.style.webkitLineClamp = previous;
        setOverflowing(full > el.clientHeight + 1);
    }, [children, lines, expanded]);

    const text = (
        <div
            ref={textRef}
            className={expanded ? "ui-clamp__text ui-clamp__text--expanded" : "ui-clamp__text"}
            style={expanded ? undefined : ({ "--ui-clamp-lines": lines } as CSSProperties)}
        >
            {children}
        </div>
    );

    if (!overflowing) return <div className={className}>{text}</div>;
    return (
        <button
            type="button"
            className={className ? `${className} ui-clamp--toggle` : "ui-clamp--toggle"}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
        >
            {text}
        </button>
    );
}
