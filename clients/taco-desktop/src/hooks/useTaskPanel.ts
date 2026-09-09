/**
 * useTaskPanel — Task panel open/close.
 * Intentionally minimal: a single open boolean is sufficient.
 */
import { useCallback, useState } from "react";

export interface UseTaskPanelApi {
    open: boolean;
    show: () => void;
    close: () => void;
    toggle: () => void;
}

export function useTaskPanel(): UseTaskPanelApi {
    const [open, setOpen] = useState(false);
    const show = useCallback(() => setOpen(true), []);
    const close = useCallback(() => setOpen(false), []);
    const toggle = useCallback(() => setOpen((v) => !v), []);
    return { open, show, close, toggle };
}
