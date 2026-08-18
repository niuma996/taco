/**
 * `taco upgrade --apply` — atomic swap of the staged bundle into the
 * live install dir, then clear the marker. Triggered by the UI's
 * reconnect loop after the daemon's UpgradeOrchestrator has shut itself
 * down (because the marker pointed at a real staging dir).
 *
 * Swap strategy:
 *   1. Read the marker (missing → throw; the UI should fall back to
 *      plain `taco start` in that case).
 *   2. Verify the staging dir still exists with a manifest.json — the
 *      operator may have wiped $TACO_HOME/staging while the daemon was
 *      still running, in which case we refuse to swap (would leave the
 *      live dir untouched but still clear the marker).
 *   3. Rename `live_dir` → `live_dir.prev` (atomic on the same fs;
 *      leaves a rollback target).
 *   4. Rename `staging_dir` → `live_dir` (atomic if prev rename
 *      succeeded; on EXDEV across filesystems we fall back to
 *      copyFile + unlink so a cross-mount install doesn't wedge).
 *   5. On any failure: rename `live_dir.prev` back to `live_dir`
 *      so the daemon's next start picks up the old binary instead of
 *      a half-swapped tree.
 *   6. Clear the marker.
 *   7. Best-effort: send control.shutdown so the (about-to-restart)
 *      daemon stops cleanly; the service manager (launchd / schtasks)
 *      respawns against the new binary. If no service is installed,
 *      the UI's reconnect loop runs `taco start` itself.
 */

import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TACO_HOME, UPGRADE_MARKER } from "./paths.ts";
import { createLogger } from "./upgradeLogger.ts";
import { clearUpgradeMarker, readUpgradeMarker } from "./upgradeMarker.ts";
import type { UpgradeApplyResult } from "./upgradeTypes.ts";

const log = createLogger("taco.cli.upgrade.apply");

export interface UpgradeApplyOptions {
    /** Override $TACO_HOME (defaults to env / ~/.taco). */
    tacoHome?: string;
    /** Stop hook — injected so tests can skip the control-channel call. */
    stop?: () => Promise<void>;
}

export async function upgradeApplyCommand(
    opts: UpgradeApplyOptions = {},
): Promise<UpgradeApplyResult> {
    const tacoHome = opts.tacoHome ?? TACO_HOME;
    const markerPath = UPGRADE_MARKER.startsWith(tacoHome)
        ? UPGRADE_MARKER
        : join(tacoHome, "upgrade-marker.json");

    const marker = await readUpgradeMarker(markerPath);
    if (!marker) {
        throw new Error("no upgrade pending; marker absent at " + markerPath);
    }

    log.info(`applying upgrade → version=${marker.version}, live=${marker.live_dir}`);

    // Verify staging is still usable before touching live_dir.
    //
    // Two distinct failures, deliberately handled differently:
    //   - staging dir gone entirely (commonly /tmp cleanup) → this upgrade can
    //     never complete, so clear the marker. Leaving it would make every
    //     later boot re-attempt a dead path forever.
    //   - staging present but malformed → keep the marker. Re-running
    //     `taco upgrade` can re-download into the same slot and recover.
    // Both still throw: the non-zero exit is the signal the desktop's
    // reconnect loop needs to stop retrying the apply.
    if (!(await isDirectory(marker.staging_dir))) {
        log.warn(`staging dir missing (${marker.staging_dir}); clearing unusable marker`);
        await clearUpgradeMarker(markerPath);
        throw new Error(`staging dir missing: ${marker.staging_dir}`);
    }
    await assertBundleShape(marker.staging_dir);

    const prevDir = `${marker.live_dir}.prev`;
    // Clear any stale rollback target from a prior failed attempt.
    await rm(prevDir, { recursive: true, force: true });

    // Step 1: live → prev
    try {
        await rename(marker.live_dir, prevDir);
    } catch (err) {
        throw new Error(`failed to move live_dir → prev: ${String(err)}`);
    }

    // Step 2: staging → live. Try the same-fs atomic rename first; on EXDEV
    // (cross-filesystem) fall back to recursive copy + unlink so cross-mount
    // installs aren't wedged. If the copy fails mid-flight, rename(prevDir,
    // liveDir) restores the original.
    try {
        try {
            await rename(marker.staging_dir, marker.live_dir);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EXDEV") throw err;
            log.warn("cross-device rename; falling back to copyFile + unlink");
            await copyDir(marker.staging_dir, marker.live_dir);
            await rm(marker.staging_dir, { recursive: true, force: true });
        }
    } catch (err) {
        log.error(`swap failed, rolling back: ${String(err)}`);
        try {
            await rm(marker.live_dir, { recursive: true, force: true });
            await rename(prevDir, marker.live_dir);
        } catch (rollbackErr) {
            log.error(`rollback also failed: ${String(rollbackErr)}`);
        }
        throw err;
    }

    // Step 3: clear the marker so the daemon's next boot doesn't re-trigger.
    await clearUpgradeMarker(markerPath);

    // Step 4: best-effort stop. The orchestrator already asked the daemon
    // to shut down (when it saw the marker), but a slow shutdown or a
    // non-orchestrator trigger (manual `taco upgrade --apply`) means the
    // daemon might still be running with the old binary in memory. We
    // send control.shutdown anyway; if it's already gone we swallow the
    // ECONNREFUSED.
    if (opts.stop) {
        try {
            await opts.stop();
        } catch (err) {
            log.warn(`best-effort stop failed (ignored): ${String(err)}`);
        }
    }

    // Step 5: drop the rollback target. Safe to delay if rm fails — the
    // next upgrade overwrites it anyway.
    await rm(prevDir, { recursive: true, force: true }).catch(() => undefined);

    log.info(`upgrade applied → version=${marker.version}`);
    return { version: marker.version };
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function assertBundleShape(stagingDir: string): Promise<void> {
    try {
        await stat(join(stagingDir, "manifest.json"));
    } catch {
        throw new Error(`staging dir missing manifest.json: ${stagingDir}`);
    }
}

/** Recursive copy used by the EXDEV fallback. `cp -R` semantics: each
 *  file's bytes copied; symlinks dereferenced (we don't trust the
 *  staging tarball to ship symlinks we want to preserve). */
async function copyDir(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    for await (const entry of await import("node:fs/promises").then((m) =>
        m.readdir(src, { withFileTypes: true }),
    )) {
        const s = join(src, entry.name);
        const d = join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(s, d);
        } else if (entry.isFile()) {
            await copyFile(s, d);
        }
        // Skip symlinks / sockets / devices — platform tarballs ship none,
        // and copying them blindly is a security smell.
    }
}
