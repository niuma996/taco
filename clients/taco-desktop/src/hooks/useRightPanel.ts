/**
 * useRightPanel — the single right-side slot shared by the task list, file
 * tree, and subagent panel.
 *
 * One value instead of three booleans: the three panels occupy the same slot,
 * so mutual exclusion is a property of the state, not something each toggle
 * has to remember to enforce.
 */
import { useCallback, useState } from "react";
import { clampPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH } from "../lib/chat/subagentList";
import { readPersistedRightPanelWidth, writePersistedRightPanelWidth } from "../lib/clientSettings";
import { type DragHandleProps, useDragResize } from "./primitives/useDragResize";

export type RightPanelKind = "none" | "tasks" | "files" | "subagents";

export interface UseRightPanelApi {
    panel: RightPanelKind;
    toggle: (kind: Exclude<RightPanelKind, "none">) => void;
    close: () => void;
    /** Opens unconditionally; auto-open must not toggle an open panel closed. */
    show: (kind: Exclude<RightPanelKind, "none">) => void;
    /** Shared by all three panels; already clamped to the current viewport. */
    width: number;
    resizeHandleProps: DragHandleProps;
}

export function useRightPanel(): UseRightPanelApi {
    const [panel, setPanel] = useState<RightPanelKind>("none");

    const toggle = useCallback((kind: Exclude<RightPanelKind, "none">) => {
        setPanel((current) => (current === kind ? "none" : kind));
    }, []);

    const close = useCallback(() => setPanel("none"), []);
    const show = useCallback((kind: Exclude<RightPanelKind, "none">) => setPanel(kind), []);

    // Re-clamped on every read rather than written back: a window narrower than
    // the persisted width should render narrower without losing the preference.
    const clamp = useCallback((raw: number) => clampPanelWidth(raw, window.innerWidth), []);

    const { width, handleProps: resizeHandleProps } = useDragResize({
        initial: readPersistedRightPanelWidth() ?? RIGHT_PANEL_DEFAULT_WIDTH,
        min: 220,
        max: 640,
        clamp,
        onCommit: writePersistedRightPanelWidth,
    });

    return { panel, toggle, close, show, width, resizeHandleProps };
}
