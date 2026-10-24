/**
 * UserMessageGuide — the left rail that indexes every user message of the
 * session.
 *
 * The rail is a controlled component: `entries` is derived by the caller from
 * the full message list (so the rail lists messages the render window has not
 * mounted yet), `activeId` names the message the chat is currently showing,
 * and `onNavigate` is the only way to ask for a jump. Scrolling the chat is
 * not this component's business — it only moves its own rail.
 *
 * Radix HoverCard owns the preview's portal, collision avoidance and focus
 * handling. What lives here is the roving tabindex over the markers and the
 * small correction that keeps the active marker inside the rail's band.
 *
 * Memoized: the chat re-renders on every streaming token, and the rail must
 * not follow it. Its props have to be stable for that to hold — the entries
 * come from `useStableUserMessageGuide`, the navigation callback is stable.
 */

import * as HoverCard from "@radix-ui/react-hover-card";
import type { KeyboardEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n/useI18n";
import type { UserMessageGuideEntry } from "../lib/chat/userMessageGuide";

/** Characters kept in a preview before the text is cut short. */
export const PREVIEW_TEXT_LIMIT = 800;

/** Image thumbnails shown in a preview. */
export const PREVIEW_IMAGE_LIMIT = 4;

export interface UserMessageGuideProps {
    /** Every user message of the session, in order. */
    entries: readonly UserMessageGuideEntry[];
    /** Id of the message the chat is currently showing. */
    activeId?: string;
    /** Called with the entry the user picked. */
    onNavigate: (entry: UserMessageGuideEntry) => void;
}

interface GuidePreviewProps {
    entry: UserMessageGuideEntry;
    /** 1-based position of the entry in the rail. */
    index: number;
    total: number;
}

/** Hover card body — the message text, its images and the truncation notice. */
function GuidePreview({ entry, index, total }: GuidePreviewProps) {
    const { t } = useT();
    const truncated = entry.text.length > PREVIEW_TEXT_LIMIT;
    // slice keeps the newlines of the retained part — the preview wraps the
    // text the same way the bubble does.
    const shownText = truncated ? entry.text.slice(0, PREVIEW_TEXT_LIMIT) : entry.text;
    const images = entry.images.slice(0, PREVIEW_IMAGE_LIMIT);

    return (
        <div className="user-message-guide__preview-body">
            <div className="user-message-guide__preview-position">
                {t("message.guidePosition", { index, total })}
            </div>
            {shownText ? (
                <div
                    className="user-message-guide__preview-text"
                    data-testid="user-message-preview-text"
                >
                    {shownText}
                </div>
            ) : (
                <div
                    className="user-message-guide__preview-fallback"
                    data-testid="user-message-preview-fallback"
                >
                    {entry.images.length > 0
                        ? t("message.guideImageOnly")
                        : t("message.guideEmpty")}
                </div>
            )}
            {entry.images.length > 0 && (
                <>
                    <div className="user-message-guide__preview-images">
                        {images.map((image, i) => (
                            <img
                                key={`${image.mimeType}-${image.data.slice(0, 8)}-${i}`}
                                className="user-message-guide__preview-image"
                                src={`data:${image.mimeType};base64,${image.data}`}
                                alt=""
                            />
                        ))}
                    </div>
                    <div
                        className="user-message-guide__preview-image-count"
                        data-testid="user-message-preview-image-count"
                    >
                        {t("message.guideImageCount", { count: entry.images.length })}
                    </div>
                </>
            )}
            {truncated && (
                <div
                    className="user-message-guide__preview-notice"
                    data-testid="user-message-preview-notice"
                >
                    {t("message.guideTruncated")}
                </div>
            )}
        </div>
    );
}

export const UserMessageGuide = memo(function UserMessageGuide({
    entries,
    activeId,
    onNavigate,
}: UserMessageGuideProps) {
    const { t } = useT();
    const railRef = useRef<HTMLDivElement | null>(null);
    const markersRef = useRef(new Map<string, HTMLButtonElement>());
    const [focusIndex, setFocusIndex] = useState(0);

    const activeIndex = useMemo(
        () => entries.findIndex((entry) => entry.id === activeId),
        [entries, activeId],
    );

    // The tab stop follows the active message, so Tab enters the rail on the
    // row the chat is showing rather than on a stale position. Without an
    // active message the index has to be clamped: a shorter list would
    // otherwise leave every marker outside the tab order.
    useEffect(() => {
        if (activeIndex >= 0) {
            setFocusIndex(activeIndex);
            return;
        }
        setFocusIndex((index) => Math.min(index, Math.max(0, entries.length - 1)));
    }, [activeIndex, entries.length]);

    // Keep the active marker inside the rail's visible band. The rail scrolls
    // on its own, so the chat's scroll position stays untouched.
    useEffect(() => {
        const rail = railRef.current;
        const marker = activeId ? markersRef.current.get(activeId) : undefined;
        if (!rail || !marker) return;
        const top = marker.offsetTop;
        const bottom = top + marker.offsetHeight;
        const viewTop = rail.scrollTop;
        const viewBottom = viewTop + rail.clientHeight;
        if (top < viewTop) {
            rail.scrollTop = top;
        } else if (bottom > viewBottom) {
            rail.scrollTop = bottom - rail.clientHeight;
        }
    }, [activeId]);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
            let next: number;
            switch (event.key) {
                case "ArrowDown":
                    next = Math.min(index + 1, entries.length - 1);
                    break;
                case "ArrowUp":
                    next = Math.max(index - 1, 0);
                    break;
                case "Home":
                    next = 0;
                    break;
                case "End":
                    next = entries.length - 1;
                    break;
                case "Enter":
                case " ": {
                    // Activation is handled here instead of relying on the
                    // browser's native button activation: a DOM without
                    // activation emulation (happy-dom) never synthesises the
                    // click, and preventDefault keeps a real browser from
                    // firing a second one.
                    event.preventDefault();
                    onNavigate(entries[index]);
                    return;
                }
                default:
                    return;
            }
            event.preventDefault();
            setFocusIndex(next);
            markersRef.current.get(entries[next].id)?.focus();
        },
        [entries, onNavigate],
    );

    return (
        <nav className="user-message-guide" aria-label={t("message.guideLabel")}>
            <span className="sr-only">
                {t("message.guideCountValue", { count: entries.length })}
            </span>
            <div
                className="user-message-guide__count"
                data-testid="user-message-count"
                aria-hidden="true"
            >
                {entries.length}
            </div>
            <div className="user-message-guide__rail" data-testid="user-message-rail" ref={railRef}>
                {entries.map((entry, index) => (
                    <HoverCard.Root key={entry.id} openDelay={0}>
                        <HoverCard.Trigger asChild>
                            <button
                                type="button"
                                className="user-message-guide__marker"
                                aria-label={t("message.guideItem", { index: index + 1 })}
                                aria-current={activeId === entry.id ? "location" : undefined}
                                tabIndex={index === focusIndex ? 0 : -1}
                                onClick={() => onNavigate(entry)}
                                onKeyDown={(event) => handleKeyDown(event, index)}
                                ref={(el) => {
                                    if (el) markersRef.current.set(entry.id, el);
                                    else markersRef.current.delete(entry.id);
                                }}
                            >
                                <span className="user-message-guide__dot" />
                            </button>
                        </HoverCard.Trigger>
                        <HoverCard.Portal>
                            <HoverCard.Content
                                className="user-message-guide__preview"
                                data-testid={`user-message-preview-${entry.id}`}
                                side="right"
                                align="start"
                                sideOffset={8}
                                collisionPadding={8}
                            >
                                <GuidePreview
                                    entry={entry}
                                    index={index + 1}
                                    total={entries.length}
                                />
                            </HoverCard.Content>
                        </HoverCard.Portal>
                    </HoverCard.Root>
                ))}
            </div>
        </nav>
    );
});
