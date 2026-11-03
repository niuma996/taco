/**
 * Right-panel geometry — the width contract shared by the task list, file
 * tree, and subagent panel.
 *
 * The panel owns a *share* of the chat area (the layout width minus the
 * sidebar), not a pixel width: 280px is a sliver on a wide display and half
 * the screen on a narrow one, and one stored preference cannot serve both.
 */

/** Default share of the chat area. */
export const RIGHT_PANEL_DEFAULT_RATIO = 0.3;

/** Hard ceiling — the panel never takes more than half of the chat area. */
export const RIGHT_PANEL_MAX_RATIO = 0.5;

/** Absolute floor in px. Below this the panel's own header stops fitting. */
export const RIGHT_PANEL_MIN_WIDTH = 250;

/**
 * Activity rail width, mirroring `--rail-width` in theme.css. Duplicated in
 * JS for the same reason as `--pane-width`: a custom property holding a
 * `clamp()` comes back unresolved from getComputedStyle, and this one is
 * read on every layout computation. Keep in sync with theme.css.
 */
const RAIL_WIDTH = 56;

/** Stand-in when the viewport size is unavailable or nonsensical. */
const FALLBACK_VIEWPORT_WIDTH = 1440;

function validViewport(viewportWidth: number): number {
    return Number.isFinite(viewportWidth) && viewportWidth > 0
        ? viewportWidth
        : FALLBACK_VIEWPORT_WIDTH;
}

/**
 * Sidebar width in px, mirroring `--pane-width` in theme.css
 * (`clamp(220px, 20vw, 340px)`). Duplicated in JS because custom properties
 * holding a `clamp()` come back unresolved from getComputedStyle, so the
 * value cannot be read back from CSS. Keep in sync with theme.css.
 */
export function sidebarWidthPx(viewportWidth: number, collapsed: boolean): number {
    if (collapsed) return 0;
    return Math.min(340, Math.max(220, validViewport(viewportWidth) * 0.2));
}

/**
 * The chat area the panel shares with the chat column: the layout width minus
 * the sidebar. The layout's own 12px of margin is not subtracted — it moves
 * the panel by less than 4px.
 */
export function chatAreaWidth(viewportWidth: number, collapsed: boolean): number {
    const layout = validViewport(viewportWidth) - RAIL_WIDTH;
    return Math.max(0, layout - sidebarWidthPx(viewportWidth, collapsed));
}

/**
 * Smallest share the panel may take: the 250px floor and the default 30%,
 * whichever is wider. Dropping below the default would make "drag it smaller"
 * mean "smaller than it starts out". Capped at the hard ceiling, so the 50%
 * limit still wins over both on narrow layouts.
 */
export function minPanelRatio(chatArea: number): number {
    if (!Number.isFinite(chatArea) || chatArea <= 0) return RIGHT_PANEL_MAX_RATIO;
    const pxFloor = RIGHT_PANEL_MIN_WIDTH / chatArea;
    return Math.min(RIGHT_PANEL_MAX_RATIO, Math.max(pxFloor, RIGHT_PANEL_DEFAULT_RATIO));
}

/** Effective share for a requested one. */
export function clampPanelRatio(raw: unknown, chatArea: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return RIGHT_PANEL_DEFAULT_RATIO;
    return Math.min(RIGHT_PANEL_MAX_RATIO, Math.max(minPanelRatio(chatArea), raw));
}

/**
 * Rendered width in px for an effective share. The share already encodes
 * both bounds, so this never clamps on its own — doing so would push the
 * panel past the 50% ceiling on narrow layouts.
 */
export function panelWidthPx(ratio: number, chatArea: number): number {
    if (!Number.isFinite(chatArea) || chatArea <= 0) return 0;
    return Math.round(ratio * chatArea);
}
