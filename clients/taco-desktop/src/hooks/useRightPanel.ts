/**
 * useRightPanel — the single right-side slot shared by the task list, file
 * tree, and subagent panel.
 *
 * One value instead of three booleans: the three panels occupy the same slot,
 * so mutual exclusion is a property of the state, not something each toggle
 * has to remember to enforce.
 */
import { useCallback, useState } from "react";

export type RightPanelKind = "none" | "tasks" | "files" | "subagents";

export interface UseRightPanelApi {
    panel: RightPanelKind;
    toggle: (kind: Exclude<RightPanelKind, "none">) => void;
    close: () => void;
    /** Opens unconditionally; auto-open must not toggle an open panel closed. */
    show: (kind: Exclude<RightPanelKind, "none">) => void;
}

export function useRightPanel(): UseRightPanelApi {
    const [panel, setPanel] = useState<RightPanelKind>("none");

    const toggle = useCallback((kind: Exclude<RightPanelKind, "none">) => {
        setPanel((current) => (current === kind ? "none" : kind));
    }, []);

    const close = useCallback(() => setPanel("none"), []);
    const show = useCallback((kind: Exclude<RightPanelKind, "none">) => setPanel(kind), []);

    return { panel, toggle, close, show };
}
