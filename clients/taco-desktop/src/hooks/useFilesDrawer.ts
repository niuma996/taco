/**
 * useFilesDrawer — Files drawer open/close.
 * Intentionally minimal: a single open boolean is sufficient.
 */
import { useCallback, useState } from "react";

export interface UseFilesDrawerApi {
    open: boolean;
    show: () => void;
    close: () => void;
}

export function useFilesDrawer(): UseFilesDrawerApi {
    const [open, setOpen] = useState(false);
    const show = useCallback(() => setOpen(true), []);
    const close = useCallback(() => setOpen(false), []);
    return { open, show, close };
}
