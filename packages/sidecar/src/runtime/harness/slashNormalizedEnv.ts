/**
 * Slash-normalized execution env — a thin wrapper around pi-agent-core's
 * NodeExecutionEnv that rewrites backslash-separated Windows paths in the
 * `path` / `name` fields of returned FileInfo entries to forward slashes.
 *
 * Why: pi-agent-core's `relativeEnvPath(root, path)` in
 * `dist/harness/skills.js` compares paths with `path.startsWith(root + "/")`,
 * expecting both to use `/` separators. NodeExecutionEnv on Windows calls
 * `resolve(...)` which yields `\`-separated paths, so the comparison fails
 * and the fallback `path.replace(/^\/+/, "")` returns the absolute path
 * unchanged. The `ignore` package then throws "path should be a
 * `path.relative()`'d string" when handed that absolute path.
 *
 * The same wrapper also fixes `name`, which `fileInfoFromStats` derives via
 * `path.split("/").pop()` — on a backslash path that returns the whole
 * absolute path as the "name", breaking `.hidden` / `node_modules` filtering
 * inside loadSkillsFromDirInternal.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileError, FileInfo, Result } from "../pi/node.ts";
import { NodeExecutionEnv, FileError as NodeFileError } from "../pi/node.ts";
import type { Context } from "../pi/types.ts";

/** Normalize one FileInfo's `path` + `name` to forward slashes. */
function normalizeFileInfo(info: FileInfo): FileInfo {
    const normalizedPath = info.path.replace(/\\/g, "/");
    return {
        ...info,
        path: normalizedPath,
        // Recompute name so `.split("/")` actually splits on a real
        // separator — pi-agent-core's `fileInfoFromStats` only handles
        // forward-slash paths.
        name: normalizedPath.split("/").pop() ?? info.name,
    };
}

export class SlashNormalizedExecutionEnv extends NodeExecutionEnv {
    override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
        const resolved = await this.absolutePath(path, context);
        if (!resolved.ok) return resolved;
        const directory = resolved.value;
        if (context.abortSignal?.aborted) {
            return { ok: false, error: new NodeFileError("aborted", "aborted", directory) };
        }
        try {
            const entries = await readdir(directory, { withFileTypes: true });
            const infos: FileInfo[] = [];
            for (const entry of entries) {
                if (context.abortSignal?.aborted) {
                    return { ok: false, error: new NodeFileError("aborted", "aborted", directory) };
                }
                const entryPath = join(directory, entry.name);
                try {
                    const stats = await lstat(entryPath);
                    const kind = stats.isFile()
                        ? "file"
                        : stats.isDirectory()
                          ? "directory"
                          : stats.isSymbolicLink()
                            ? "symlink"
                            : undefined;
                    if (!kind) {
                        return {
                            ok: false,
                            error: new NodeFileError("invalid", "Unsupported file type", entryPath),
                        };
                    }
                    infos.push(
                        normalizeFileInfo({
                            name: entry.name,
                            path: entryPath,
                            kind,
                            size: stats.size,
                            mtimeMs: stats.mtimeMs,
                        }),
                    );
                } catch (error) {
                    // A session fork's .jsonl.tmp can be renamed away after
                    // readdir. That entry no longer exists; failing the whole
                    // listing would abort unrelated, concurrently spawning agents.
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                    throw error;
                }
            }
            return { ok: true, value: infos };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const kind =
                code === "ENOENT"
                    ? "not_found"
                    : code === "ENOTDIR"
                      ? "not_directory"
                      : code === "EACCES" || code === "EPERM"
                        ? "permission_denied"
                        : "unknown";
            return {
                ok: false,
                error: new NodeFileError(
                    kind,
                    error instanceof Error ? error.message : String(error),
                    directory,
                    error instanceof Error ? error : undefined,
                ),
            };
        }
    }

    override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
        const result = await super.fileInfo(path, context);
        if (!result.ok) return result;
        return { ok: true, value: normalizeFileInfo(result.value) };
    }

    override async canonicalPath(
        path: string,
        context: Context,
    ): Promise<Result<string, FileError>> {
        const result = await super.canonicalPath(path, context);
        if (!result.ok) return result;
        return { ok: true, value: result.value.replace(/\\/g, "/") };
    }
}
