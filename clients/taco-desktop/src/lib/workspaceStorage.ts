/**
 * Workspace localStorage persistence — centralizes `LS_WORKSPACES` / `LS_ACTIVE` constants and
 * read/write/validation logic. Previously scattered across App.tsx + init() + openWorkspace()
 * in 3 places; any cwd validation rule change required updating all 3. Now hooks/views call
 * a single API.
 */

import { invoke } from "@tauri-apps/api/core";

export const LS_WORKSPACES = "taco.workspaces";
export const LS_ACTIVE = "taco.activeCwd";

/**
 * Synchronous fallback default workspace cwd.
 *
 * The real value is `$TACO_HOME/workspace`, but that requires a runtime query to Rust, while
 * `loadOpenedCwds` / `resolveActiveCwd` are synchronous pure functions. We default to the empty
 * string — `isValidWorkspaceCwd("")` returns false, so no read before `initDefaultCwd()` succeeds
 * will surface a wrong hard-coded path. `resolveActiveCwd` takes the `opened[0]` branch
 * (already-persisted cwds from localStorage) rather than the fallback string.
 *
 * Historical baggage: we once hard-coded `/tmp/taco-demo` — macOS periodically cleans `/tmp`,
 * the code never created it, so first launch pointed to a non-existent path; the sidecar used
 * it as the stdio MCP server default cwd, and spawns failed with "command ENOENT" without
 * pointing to the real cause. The empty-string fallback removes the footgun.
 */
let defaultCwd = "";

/** Current default workspace cwd (synchronous fallback before `initDefaultCwd` resolves). */
export function getDefaultCwd(): string {
    return defaultCwd;
}

/**
 * Resolves `$TACO_HOME/workspace` from Rust (also creates it), then caches it. Called once
 * at startup, before reading localStorage. On failure keeps the fallback value; does not block.
 */
export async function initDefaultCwd(): Promise<string> {
    try {
        const dir = await invoke<string>("default_workspace_dir");
        if (dir) defaultCwd = dir;
    } catch (e) {
        console.warn("[taco] default workspace dir unavailable; keeping fallback", e);
    }
    return defaultCwd;
}

/**
 * Filters a list by existence flags — the pure-function core of `pruneMissingCwds`, extracted
 * for Tauri-independent unit testing.
 *
 * `flags` aligns with `cwds` 1:1; missing or non-`false` entries are treated as present
 * (better to keep a non-existent cwd than to drop one by mistake).
 * `keepAlways` (default cwd) is always retained: `initDefaultCwd` guarantees it exists, and
 * it's the fallback when the list would otherwise be empty — removing it would cause the
 * fallback to point to a cwd not in the list.
 */
export function applyExistenceFlags(
    cwds: string[],
    flags: boolean[] | undefined,
    keepAlways: string,
): string[] {
    if (!Array.isArray(flags)) return cwds;
    const kept = cwds.filter((cwd, i) => flags[i] !== false || cwd === keepAlways);
    const dropped = cwds.filter((cwd) => !kept.includes(cwd));
    if (dropped.length > 0) {
        console.warn(
            `[taco] dropped ${dropped.length} workspace(s) whose directory no longer exists: ${dropped.join(", ")}`,
        );
    }
    return kept;
}

/**
 * Pure helper extracted from `pruneMissingCwds`: after pruning, if no workspace
 * survived, reseed the list with the default cwd so resolveActiveCwd /
 * switchWorkspace still have a target. Returns the input unchanged when
 * `defaultCwd` is empty (initDefaultCwd never resolved) — in that case there's
 * nothing safe to seed with.
 */
export function reseedDefaultIfEmpty(kept: string[], defaultCwd: string): string[] {
    if (kept.length > 0) return kept;
    return defaultCwd ? [defaultCwd] : kept;
}

/**
 * Prunes directories that no longer exist. Directories can be moved/deleted; OS also cleans
 * `/tmp`. Invalid workspaces cause the sidecar to emit errors on every startup.
 * The default cwd is always retained — `initDefaultCwd` guarantees it exists, and it's the
 * fallback when the list would otherwise be empty.
 */
export async function pruneMissingCwds(cwds: string[]): Promise<string[]> {
    if (cwds.length === 0) {
        // No stored workspaces — seed with the default cwd so a fresh install
        // (or a wiped webview storage) doesn't render an empty dropdown.
        return defaultCwd ? [defaultCwd] : cwds;
    }
    try {
        const flags = await invoke<boolean[]>("paths_are_dirs", { paths: cwds });
        const kept = applyExistenceFlags(cwds, flags, defaultCwd);
        // After pruning the list can empty out (typical case: a previous install
        // persisted only stale relative paths that no longer resolve). Reseed with
        // the default cwd so resolveActiveCwd / switchWorkspace still have a
        // valid target — the default was just created by initDefaultCwd.
        return reseedDefaultIfEmpty(kept, defaultCwd);
    } catch (e) {
        // Never let a failed check strip the user's workspace list.
        console.warn("[taco] workspace existence check failed; keeping list as-is", e);
        return cwds;
    }
}

/**
 * Validates cwd — rejects strings containing globs (`*` `?` `[`) or shell metacharacters (`$` `` ` ``).
 * Both absolute and relative paths are accepted, as long as they don't contain characters that would
 * be misinterpreted by the shell or Rust.
 *
 * Historical issue: a pasted `src-tauri/*` caused the frontend key to diverge from the Rust-side
 * normalized key, resulting in all session-level RPCs throwing "workspace not ensured".
 */
export function isValidWorkspaceCwd(cwd: string): boolean {
    if (cwd.length === 0) return false;
    return !/[*?[\]$`]/.test(cwd);
}

/** Returns the last path segment (used in dropdown display); empty string returned as-is. */
export function lastSegment(p: string): string {
    if (!p) return "";
    const m = p.match(/[^/\\]+$/);
    return m ? m[0] : p;
}

/** Reads the list of opened workspaces from localStorage (cwd array). */
export function loadOpenedCwds(): string[] {
    try {
        const raw = localStorage.getItem(LS_WORKSPACES);
        const arr = raw ? (JSON.parse(raw) as unknown) : null;
        if (Array.isArray(arr)) {
            const all = arr.filter((x): x is string => typeof x === "string");
            const valid = all.filter(isValidWorkspaceCwd);
            const dropped = all.length - valid.length;
            if (dropped > 0) {
                console.warn(
                    `[taco] dropped ${dropped} invalid cwd(s) from localStorage (likely glob / shell patterns); clearing stored list.`,
                );
                try {
                    localStorage.setItem(LS_WORKSPACES, JSON.stringify(valid));
                } catch {
                    // ignore quota
                }
            }
            if (valid.length > 0) return valid;
        }
    } catch {
        // ignore corrupt storage
    }
    // Empty defaultCwd means `initDefaultCwd()` hasn't run yet — return []
    // instead of [""] so callers don't surface an invalid cwd before Rust
    // resolves the real path.
    return defaultCwd ? [defaultCwd] : [];
}

/** Validates and returns the current active cwd: stored > opened[0] > default cwd. */
export function resolveActiveCwd(stored: string | null, opened: string[]): string {
    if (stored && isValidWorkspaceCwd(stored)) return stored;
    if (stored && !isValidWorkspaceCwd(stored)) {
        console.warn(
            `[taco] LS_ACTIVE contains invalid cwd ${JSON.stringify(stored)}; falling back`,
        );
        try {
            localStorage.removeItem(LS_ACTIVE);
        } catch {
            // ignore
        }
    }
    return opened[0] ?? defaultCwd;
}

/** Writes the active cwd to localStorage; silently fails on quota / disabled storage. */
export function persistActiveCwd(cwd: string): void {
    try {
        localStorage.setItem(LS_ACTIVE, cwd);
    } catch {
        // ignore
    }
}

/** Writes the workspace list to localStorage. */
export function persistCwds(cwds: string[]): void {
    try {
        localStorage.setItem(LS_WORKSPACES, JSON.stringify(cwds));
    } catch {
        // ignore
    }
}
