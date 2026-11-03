/**
 * useRightPanel — the single right-side slot shared by the task list, file
 * tree, and subagent panel.
 *
 * One value instead of three booleans: the three panels occupy the same slot,
 * so mutual exclusion is a property of the state, not something each toggle
 * has to remember to enforce.
 *
 * Width is a share of the chat area, not a pixel width: the same preference
 * then reads the same on a laptop and on a wide display.
 */
import { useCallback, useEffect, useState } from "react";
import {
    consumeLegacyRightPanelWidth,
    readPersistedRightPanelRatio,
    writePersistedRightPanelRatio,
} from "../lib/clientSettings";
import {
    chatAreaWidth,
    clampPanelRatio,
    panelWidthPx,
    RIGHT_PANEL_DEFAULT_RATIO,
    RIGHT_PANEL_MAX_RATIO,
} from "../lib/rightPanelWidth";
import { type DragHandleProps, useDragResize } from "./primitives/useDragResize";

export type RightPanelKind = "none" | "tasks" | "files" | "subagents";

/** Keyboard step in share units; Shift jumps five times as far. */
const KEY_STEP = 0.02;
const KEY_STEP_FAST = 0.05;

export interface UseRightPanelApi {
    panel: RightPanelKind;
    toggle: (kind: Exclude<RightPanelKind, "none">) => void;
    close: () => void;
    /** Opens unconditionally; auto-open must not toggle an open panel closed. */
    show: (kind: Exclude<RightPanelKind, "none">) => void;
    /** Rendered width in px, derived from the share and the current chat area. */
    width: number;
    resizeHandleProps: DragHandleProps;
}

export function useRightPanel(sidebarCollapsed = false): UseRightPanelApi {
    const [panel, setPanel] = useState<RightPanelKind>("none");

    const toggle = useCallback((kind: Exclude<RightPanelKind, "none">) => {
        setPanel((current) => (current === kind ? "none" : kind));
    }, []);

    const close = useCallback(() => setPanel("none"), []);
    const show = useCallback((kind: Exclude<RightPanelKind, "none">) => setPanel(kind), []);

    // The share resolves against the live viewport, so the rendered width has
    // to be recomputed when it changes. Resize events are coalesced into one
    // frame so a window drag does not re-render the app per event.
    const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
    useEffect(() => {
        let frame = 0;
        const onResize = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setViewportWidth(window.innerWidth));
        };
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            cancelAnimationFrame(frame);
        };
    }, []);

    const chatArea = chatAreaWidth(viewportWidth, sidebarCollapsed);

    // The stored preference was a pixel width; convert it once, against the
    // current chat area, so a hand-tuned width survives the switch to shares.
    const [initialRatio] = useState(() => {
        const stored = readPersistedRightPanelRatio();
        if (stored !== undefined) return stored;
        const legacy = consumeLegacyRightPanelWidth();
        if (legacy === undefined) return RIGHT_PANEL_DEFAULT_RATIO;
        const area = chatAreaWidth(window.innerWidth, sidebarCollapsed);
        const ratio = Math.round(clampPanelRatio(legacy / area, area) * 1e4) / 1e4;
        writePersistedRightPanelRatio(ratio);
        return ratio;
    });

    const clamp = useCallback((raw: number) => clampPanelRatio(raw, chatArea), [chatArea]);

    const { width: ratio, handleProps: resizeHandleProps } = useDragResize({
        initial: initialRatio,
        min: 0,
        max: RIGHT_PANEL_MAX_RATIO,
        clamp,
        pixelsPerUnit: chatArea,
        step: KEY_STEP,
        stepFast: KEY_STEP_FAST,
        ariaValue: (value) => Math.round(value * 100),
        resetTo: RIGHT_PANEL_DEFAULT_RATIO,
        // The request is stored, not the clamped value: the 250px floor is a
        // property of the current layout, not of the user's preference.
        onCommit: (value) => writePersistedRightPanelRatio(Math.round(value * 1e4) / 1e4),
    });

    return {
        panel,
        toggle,
        close,
        show,
        width: panelWidthPx(ratio, chatArea),
        resizeHandleProps,
    };
}
