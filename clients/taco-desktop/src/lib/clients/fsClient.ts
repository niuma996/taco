/**
 * fsClient — thin wrapper over Tauri plugin-fs.
 *
 * Treats cwd as the IO context, using `resolveFsPath` to combine (cwd, rel)
 * into an absolute path before calling @tauri-apps/plugin-fs's readDir /
 * readTextFile. The absolute-path joining avoids node:path (unavailable in
 * the browser) and is just a light normalization.
 *
 * The module has zero React dependencies; the UI layer (hooks) calls
 * `createFsClient(cwd)` inside effects.
 */
import { readDir, readFile, readTextFile, stat } from "@tauri-apps/plugin-fs";

import type { FileEntry } from "../fileTypes";

export interface FsClient {
    readDir(relPath: string): Promise<FileEntry[]>;
    readText(relPath: string): Promise<string>;
    /** Raw bytes, used for image previews. */
    readBinary(relPath: string): Promise<Uint8Array>;
    /** File size in bytes; used by the preview gate before reading content. */
    sizeOf(relPath: string): Promise<number>;
}

/**
 * POSIX root, Windows drive letter, or UNC share.
 *
 * Recognising Windows forms is pure string work and is covered by tests on any
 * platform, but whether a Windows `cwd` arrives as `C:\…` or `C:/…` depends on
 * Tauri and has only been verified on POSIX. Both spellings resolve here; the
 * untested part is upstream, not this function.
 */
const ABSOLUTE_PATH_RE = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/;

/** True when the path already names a filesystem root — cwd must not be prepended. */
export function isAbsolutePath(p: string): boolean {
    return ABSOLUTE_PATH_RE.test(p);
}

/**
 * Compose cwd + rel into an absolute path. Pure string handling, no fs calls.
 *
 * An already-absolute `relPath` passes through untouched: the file tree only
 * ever produces cwd-relative paths, but tool cards address files by the path
 * the model used, which is usually absolute and may sit outside the workspace.
 *
 * A relative path must therefore NOT start with "/". An earlier version
 * stripped leading slashes, so `/src/a.ts` silently meant `<cwd>/src/a.ts`;
 * it now names the filesystem root instead. Nothing relies on the old
 * behaviour — tree paths are built by `readDir` below and never carry a leading
 * slash — but a caller inventing paths by hand has to respect the distinction.
 */
export function resolveFsPath(cwd: string, relPath: string): string {
    if (isAbsolutePath(relPath)) return relPath;
    const c = cwd.replace(/\/+$/, "");
    if (relPath === "") return c || "/";
    return `${c}/${relPath}`;
}

export function createFsClient(cwd: string): FsClient {
    const api: FsClient = {
        async readDir(relPath: string): Promise<FileEntry[]> {
            const abs = resolveFsPath(cwd, relPath);
            const entries = await readDir(abs);
            return entries.map((e) => ({
                relPath: relPath === "" ? e.name : `${relPath}/${e.name}`,
                name: e.name,
                kind: e.isDirectory ? "dir" : "file",
                size: -1,
            }));
        },
        async readText(relPath: string): Promise<string> {
            const abs = resolveFsPath(cwd, relPath);
            return readTextFile(abs);
        },
        async readBinary(relPath: string): Promise<Uint8Array> {
            const abs = resolveFsPath(cwd, relPath);
            return readFile(abs);
        },
        async sizeOf(relPath: string): Promise<number> {
            const abs = resolveFsPath(cwd, relPath);
            const info = await stat(abs);
            return info.size;
        },
    };
    return api;
}
