/**
 * Cross-platform file-permission helper for credential-bearing files.
 *
 * On Unix, `fs.chmod(path, 0o600)` strips group/world read/write, matching
 * the SECURITY.md promise that channel credentials, IM workspace policies,
 * and `taco.json` API keys are only readable by their owner.
 *
 * On Windows, POSIX mode bits are silently ignored — Node maps `0o600` to
 * `S_IWRITE`, which doesn't restrict other users on the same host. The
 * per-user profile ACL inherited at create time already keeps other accounts
 * off the file, but a shared Windows host (multiple RDP users, shared home
 * directory on a network share) is **not** protected by the same mechanism.
 *
 * This helper:
 *   1. Calls `fs.chmod` on Unix (no-op on Windows, by Node's own behavior).
 *   2. Emits a one-shot WARN log on Windows so operators notice if a
 *      sidecar ever ships to a shared host.
 *
 * SECURITY: this is best-effort defense-in-depth, not a guarantee. The
 * authoritative gate is keeping `$TACO_HOME` on a per-user filesystem
 * (`%LOCALAPPDATA%\taco` on Windows, `~/.taco` on Unix). Callers writing
 * credentials should resolve `$TACO_HOME` and never accept caller-supplied
 * credential paths.
 */

import { chmodSync } from "node:fs";
import { chmod as chmodAsync } from "node:fs/promises";
import { createLogger } from "./logger.ts";

const log = createLogger("fsPermissions");

let warnedWindows = false;

/**
 * Restrict a file (or directory) to owner-only access where the OS permits.
 * Always resolves; failures are logged and swallowed so a stuck mode bit
 * never blocks a write path — the file is the source of truth either way.
 *
 * @param path    target path
 * @param mode    POSIX mode to apply (default `0o600` — rw for owner only).
 *                `0o700` is appropriate for directories.
 */
export async function restrictOwner(path: string, mode = 0o600): Promise<void> {
    try {
        await chmodAsync(path, mode);
    } catch (err) {
        log.warn("chmod failed; credentials may be world-readable", {
            path,
            mode,
            err: String(err),
        });
        return;
    }
    warnWindowsIfNeeded();
}

/**
 * Synchronous sibling of {@link restrictOwner} for write paths that cannot
 * become async (e.g. `saveGlobalConfig` runs during config edit flows).
 */
export function restrictOwnerSync(path: string, mode = 0o600): void {
    try {
        chmodSync(path, mode);
    } catch (err) {
        log.warn("chmod failed; credentials may be world-readable", {
            path,
            mode,
            err: String(err),
        });
        return;
    }
    warnWindowsIfNeeded();
}

function warnWindowsIfNeeded(): void {
    if (process.platform === "win32" && !warnedWindows) {
        warnedWindows = true;
        // Console-only on purpose: the sidecar's structured logger routes to
        // taco.log, where this would land in front of every operator on
        // every first credential write. The security advisory is real but
        // not actionable for a per-user %LOCALAPPDATA% install, so we keep
        // it discoverable in the devtools console without polluting the
        // normal log stream.
        // biome-ignore lint/suspicious/noConsole: dev-only advisory, see comment above.
        console.warn(
            "[fsPermissions] Windows: chmod 0o600 is a no-op; credential files rely on the per-user " +
                "profile ACL. Do not put $TACO_HOME on a shared host or network share.",
        );
    }
}
