/**
 * FilePreviewOpenerContext — lets a tool card open the shared file-preview
 * popup without owning preview state or knowing the workspace root.
 *
 * The provider holds one useFilePreview instance and mounts one
 * FilePreviewPopup, so a chat stream with many `read` cards still has exactly
 * one preview surface.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";

import { FilePreviewPopup } from "../components/FilePreviewPopup";
import { createFsClient, type FsClient } from "../lib/clients/fsClient";
import { useFilePreview } from "./useFilePreview";

export interface FilePreviewOpenerValue {
    /** Opens the popup on `path` (absolute, or relative to the workspace root). */
    openPreview: (path: string) => void;
}

const FilePreviewOpenerContext = createContext<FilePreviewOpenerValue | null>(null);

export interface FilePreviewOpenerProviderProps {
    cwd: string;
    children: ReactNode;
}

export function FilePreviewOpenerProvider({ cwd, children }: FilePreviewOpenerProviderProps) {
    // resolveFsPath passes absolute paths through, so a single cwd-bound client
    // serves both workspace-relative and out-of-tree reads.
    const fsClient: FsClient = useMemo(() => createFsClient(cwd), [cwd]);
    const preview = useFilePreview(fsClient);
    const value = useMemo<FilePreviewOpenerValue>(
        () => ({ openPreview: (path: string) => void preview.select(path) }),
        [preview.select],
    );

    return (
        <FilePreviewOpenerContext.Provider value={value}>
            {children}
            <FilePreviewPopup preview={preview} cwd={cwd} />
        </FilePreviewOpenerContext.Provider>
    );
}

/** null outside a provider — callers render their entry point as unavailable. */
export function useFilePreviewOpener(): FilePreviewOpenerValue | null {
    return useContext(FilePreviewOpenerContext);
}
