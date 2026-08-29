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
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

import type { FileEntry } from "../fileTypes";

export interface FsClient {
    readDir(relPath: string): Promise<FileEntry[]>;
    readText(relPath: string): Promise<string>;
}

/** Compose cwd + rel into an absolute path. Pure string handling, no fs calls. */
export function resolveFsPath(cwd: string, relPath: string): string {
    const c = cwd.replace(/\/+$/, "");
    const r = relPath.replace(/^\/+/, "");
    if (r === "") return c || "/";
    return `${c}/${r}`;
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
    };
    return api;
}
