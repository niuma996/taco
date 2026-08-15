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

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { FileError, FileInfo, Result } from "@earendil-works/pi-agent-core/node";

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
    override async listDir(
        path: string,
        abortSignal?: AbortSignal,
    ): Promise<Result<FileInfo[], FileError>> {
        const result = await super.listDir(path, abortSignal);
        if (!result.ok) return result;
        return { ok: true, value: result.value.map(normalizeFileInfo) };
    }

    override async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
        const result = await super.fileInfo(path);
        if (!result.ok) return result;
        return { ok: true, value: normalizeFileInfo(result.value) };
    }

    override async canonicalPath(path: string): Promise<Result<string, FileError>> {
        const result = await super.canonicalPath(path);
        if (!result.ok) return result;
        return { ok: true, value: result.value.replace(/\\/g, "/") };
    }
}

/** Convert any path to forward-slash form. Idempotent on POSIX. */
export function toForwardSlashes(p: string): string {
    return p.replace(/\\/g, "/");
}
