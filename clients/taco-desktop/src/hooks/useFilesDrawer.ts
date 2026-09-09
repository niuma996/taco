/**
 * useFilesDrawer — Files panel open/close.
 * toggle exists so the session-bar button mirrors useTaskPanel: the same
 * button opens and closes the panel (there is no overlay backdrop to click).
 */
import { useCallback, useState } from "react";

export interface UseFilesDrawerApi {
    open: boolean;
    close: () => void;
    toggle: () => void;
}

export function useFilesDrawer(): UseFilesDrawerApi {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const toggle = useCallback(() => setOpen((v) => !v), []);
    return { open, close, toggle };
}
