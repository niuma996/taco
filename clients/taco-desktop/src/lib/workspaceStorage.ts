/**
 * Workspace persistence — centralizes the cwd list (`opened`) and the active
 * selection (`active`). Previously this lived in `localStorage` under
 * `taco.workspaces` / `taco.activeCwd`; it now lives in `~/.taco/desktop.json`
 * under `workspaces` so the value is shared across WebView2 origins
 * (dev `localhost:1420` vs packaged `tauri.localhost`) and follows the user
 * between machines.
 *
 * Migration: on first call, if desktop.json has no `workspaces` field but
 * localStorage still carries the old keys, copy them over and clear the
 * localStorage entries. After migration runs once the LS keys are gone and
 * the read path takes the desktop.json branch on every subsequent load.
 *
 * Hooks/views call a single API: `loadOpenedCwds`, `loadActiveCwd`,
 * `resolveActiveCwd` (pure), `persistCwds`, `persistActiveCwd`,
 * `pruneMissingCwds`.
 */

import { invoke } from "@tauri-apps/api/core";
import { readDesktopConfig, writeDesktopConfig } from "./desktopConfig.ts";

// Old localStorage keys — kept ONLY so the one-shot migration can read them
// once and clear them. No new code should write to these.
const LS_WORKSPACES_LEGACY = "taco.workspaces";
const LS_ACTIVE_LEGACY = "taco.activeCwd";

/** Flag so we don't attempt the LS→desktop.json migration more than once per process. */
let migrationChecked = false;

/**
 * Test-only: re-arms the one-shot migration. Production code should never
 * call this — `loadWorkspaces` is enough.
 */
export function __resetMigrationStateForTests(): void {
    migrationChecked = false;
}

/**
 * Synchronous fallback default workspace cwd.
 *
 * The real value is `$TACO_HOME/workspace`, but that requires a runtime query to Rust, while
 * pure helpers (`resolveActiveCwd`) need to run synchronously. We default to the empty
 * string — `isValidWorkspaceCwd("")` returns false, so no read before `initDefaultCwd()`
 * succeeds will surface a wrong hard-coded path.
 */
let defaultCwd = "";

/** Current default workspace cwd (synchronous fallback before `initDefaultCwd` resolves). */
export function getDefaultCwd(): string {
    return defaultCwd;
}

/**
 * Resolves `$TACO_HOME/workspace` from Rust (also creates it), then caches it. Called once
 * at startup, before reading workspace state. On failure keeps the fallback value; does not block.
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

/**
 * One-shot migration: if desktop.json has no `workspaces` field but localStorage
 * still carries the legacy `taco.workspaces` / `taco.activeCwd` keys (left over
 * from a previous install that stored them there), copy them across and clear
 * the localStorage entries. Idempotent — guarded by `migrationChecked`.
 *
 * Returns the migrated state when migration fired, or `null` when there was
 * nothing to migrate. Callers should fall back to the empty default in that
 * case.
 *
 * Exported with a `__` prefix for unit tests; production code goes through
 * `loadWorkspaces` which calls this internally.
 */
export function __migrateFromLocalStorage(): { opened: string[]; active: string } | null {
    if (migrationChecked) return null;
    migrationChecked = true;
    if (typeof localStorage === "undefined") return null;
    let opened: string[] | null = null;
    let active: string | null = null;
    try {
        const raw = localStorage.getItem(LS_WORKSPACES_LEGACY);
        if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
                opened = parsed.filter(
                    (x): x is string => typeof x === "string" && isValidWorkspaceCwd(x),
                );
            }
        }
    } catch {
        // ignore corrupt LS — treat as no migration source
    }
    try {
        const rawActive = localStorage.getItem(LS_ACTIVE_LEGACY);
        if (rawActive && isValidWorkspaceCwd(rawActive)) {
            active = rawActive;
        }
    } catch {
        // ignore
    }
    if (!opened && !active) return null;
    // Clear the legacy keys so a subsequent fallback (e.g. desktop.json write
    // failed) doesn't read them again and confuse the next read path.
    try {
        if (opened !== null) localStorage.removeItem(LS_WORKSPACES_LEGACY);
        if (active !== null) localStorage.removeItem(LS_ACTIVE_LEGACY);
    } catch {
        // ignore quota / disabled storage
    }
    return {
        opened: opened ?? [],
        active: active ?? "",
    };
}

/**
 * Reads the persisted `workspaces` block from `desktop.json`. On first call
 * also performs a one-shot migration from the legacy `localStorage` keys.
 * Returns `{ opened: [], active: "" }` when nothing is stored anywhere.
 *
 * Async because the read crosses an IPC boundary into the Rust host
 * (`desktop_config_read`). The previous synchronous `loadOpenedCwds` is
 * kept as a thin async wrapper so call sites that already `await` it keep
 * working.
 */
export async function loadWorkspaces(): Promise<{ opened: string[]; active: string }> {
    const config = await readDesktopConfig();
    if (config.workspaces && Array.isArray(config.workspaces.opened)) {
        // Existing desktop.json state — no migration needed.
        const opened = config.workspaces.opened.filter(isValidWorkspaceCwd);
        const active = isValidWorkspaceCwd(config.workspaces.active) ? config.workspaces.active : "";
        return { opened, active };
    }
    // No workspaces in desktop.json yet — try the one-shot LS migration.
    const migrated = __migrateFromLocalStorage();
    if (migrated) {
        // Persist immediately so a crash before the next `persistCwds` doesn't
        // leave the user re-doing the migration. Failure here is non-fatal —
        // the next read will still try, and the in-memory state is correct.
        try {
            await writeDesktopConfig({ workspaces: migrated });
        } catch (e) {
            console.warn("[taco] failed to persist migrated workspaces; will retry on next read", e);
        }
        return migrated;
    }
    return { opened: [], active: "" };
}

/**
 * Async wrapper that returns just the opened list. Drop-in replacement for
 * the old synchronous `loadOpenedCwds()` — every existing call site already
 * `await`s it (it was already async-shaped in `pruneMissingCwds`'s caller).
 */
export async function loadOpenedCwds(): Promise<string[]> {
    const { opened } = await loadWorkspaces();
    return opened;
}

/**
 * Async wrapper that returns just the active cwd (empty string when unset).
 * The previous `localStorage.getItem(LS_ACTIVE)` callers now use this.
 */
export async function loadActiveCwd(): Promise<string> {
    const { active } = await loadWorkspaces();
    return active;
}

/**
 * Validates and returns the current active cwd: stored > opened[0] > default cwd.
 *
 * Pure function — does not read storage. Callers fetch the stored value via
 * `loadActiveCwd()` and the opened list via `loadOpenedCwds()` and pass them
 * in. Kept as a pure function so the resolution rules (which cwd wins) stay
 * unit-testable without stubbing IPC.
 */
export function resolveActiveCwd(stored: string | null, opened: string[]): string {
    if (stored && isValidWorkspaceCwd(stored)) return stored;
    if (stored && !isValidWorkspaceCwd(stored)) {
        console.warn(
            `[taco] stored active cwd ${JSON.stringify(stored)} is invalid; falling back`,
        );
    }
    return opened[0] ?? defaultCwd;
}

/**
 * Persists the opened-workspace list. Async because the write crosses an IPC
 * boundary; the caller can `await` if it needs to know the result, or fire
 * and forget (the function logs but does not throw on failure).
 */
export async function persistCwds(cwds: string[]): Promise<void> {
    // Read the current active so we don't accidentally clear it when only
    // updating the opened list.
    const current = await readDesktopConfig();
    const active = current.workspaces?.active ?? "";
    try {
        await writeDesktopConfig({
            workspaces: {
                opened: cwds.filter(isValidWorkspaceCwd),
                active,
            },
        });
    } catch (e) {
        console.warn("[taco] failed to persist workspaces", e);
    }
}

/**
 * Persists the active cwd. Same fire-and-forget contract as `persistCwds`:
 * returns a Promise the caller can `await`, but never throws. If the write
 * fails, the next read still returns the previous value (the in-memory
 * `active` state used by the running session is independent).
 */
export async function persistActiveCwd(cwd: string): Promise<void> {
    if (!isValidWorkspaceCwd(cwd)) {
        console.warn(`[taco] refusing to persist invalid active cwd ${JSON.stringify(cwd)}`);
        return;
    }
    const current = await readDesktopConfig();
    const opened = current.workspaces?.opened ?? [];
    try {
        await writeDesktopConfig({
            workspaces: { opened, active: cwd },
        });
    } catch (e) {
        console.warn("[taco] failed to persist active cwd", e);
    }
}
