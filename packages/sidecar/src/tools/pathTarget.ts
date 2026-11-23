/**
 * Resolve a tool's `path` argument to what is actually on disk.
 *
 * `env.absolutePath` only expands and resolves the string; it does not check
 * existence or type. Tools that hand the result to `spawn({ cwd })` or to a
 * directory walker must distinguish "directory", "single file" and "missing"
 * themselves — a file as cwd surfaces as a bare `spawn ENOTDIR`, and a missing
 * cwd either fails with ENOENT or silently yields zero matches.
 *
 * Uses `node:fs/promises.stat` (follows symlinks) rather than `env.fileInfo`,
 * whose contract is lstat-like and cannot classify a symlink-to-file target.
 */

import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

export type PathTarget =
    | { readonly kind: "directory"; readonly root: string }
    | { readonly kind: "file"; readonly root: string; readonly name: string };

/**
 * Stat `absolutePath` and classify it. Throws an actionable error for paths
 * that do not exist (ENOENT), cannot be accessed (EACCES, ELOOP, ...), or are
 * neither a regular file nor a directory (FIFO, socket, device).
 */
export async function statPathTarget(absolutePath: string): Promise<PathTarget> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`path does not exist: ${absolutePath}`);
        throw new Error(`cannot access ${absolutePath}: ${code ?? String(error)}`);
    }
    if (info.isFile()) {
        return { kind: "file", root: dirname(absolutePath), name: basename(absolutePath) };
    }
    if (info.isDirectory()) return { kind: "directory", root: absolutePath };
    throw new Error(`path is not a regular file or directory: ${absolutePath}`);
}
