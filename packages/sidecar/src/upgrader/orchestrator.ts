/**
 * Daemon-side upgrade orchestrator.
 *
 * Flow:
 *   1. CLI's `taco upgrade` fetches a new sidecar release, downloads
 *      it to $TACO_HOME/staging/sidecar-<new>/, and writes
 *      $TACO_HOME/upgrade-marker.json with the staging + live paths.
 *   2. The daemon's `checkForUpgrade` reads the marker on every boot
 *      + every `UPGRADE_CHECK_INTERVAL_MS`. If the marker points at
 *      a staging dir that actually exists, the daemon asks its host
 *      to shut down cleanly.
 *   3. launchd (KeepAlive.SuccessfulExit=false) and schtasks (ONSTART)
 *      will NOT restart us — that's intentional: the UI's reconnect
 *      loop detects the disconnect, runs `taco upgrade --apply` (which
 *      swaps the staging contents into the live dir + relaunches the
 *      daemon), and re-establishes the NDJSON connection against the
 *      new version. The CLI's `--apply` flow owns the restart so the
 *      swap can land atomically with the relaunch.
 *
 * Why we don't broadcast `control.upgrade_available`:
 *   The plan reserved a server-pushed event for this, but the
 *   ServerPush type requires a `workspace` field and a registered
 *   method name in `@taco-ai/protocol`. Widening the protocol for one
 *   event is out of PR4 scope; the reconnect-loop + marker dance is
 *   functionally equivalent and stays within the daemon + CLI.
 *
 * Why we don't restart ourselves:
 *   launchd restart uses the SAME binary + args (the wrapper script's
 *   hardcoded paths). Without a swap, the restarted daemon points at
 *   the old version. We rely on the UI to run `--apply` instead,
 *   which swaps first then re-launches via `taco start`.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";
import { createLogger } from "../lib/logger.ts";
import { clearUpgradeMarker, readUpgradeMarker, sameInstallPath } from "./marker.ts";
import type { UpgradeMarker } from "./types.ts";

const log = createLogger("sidecar.upgrader");

export interface OrchestratorDeps {
    /** Absolute path to the upgrade-marker.json. Tests typically use
     *  a tmpdir; production reads the constant below. */
    markerPath: string;
    /** This daemon's own install root (TACO_SIDECAR_RESOURCES). Multiple
     *  installations can share one $TACO_HOME (e.g. an npm-installed
     *  sidecar and the desktop app's bundled sidecar) but only one marker
     *  exists — a marker whose live_dir points at a different root belongs
     *  to the other installation and must be left for its own daemon to
     *  honor. When unset, every marker is honored (legacy behavior). */
    liveDir?: string;
    /** Asks the daemon to exit cleanly. The daemon's existing
     *  shutdown hook unlinks sockets + closes the servers. */
    requestShutdown: (reason: string) => Promise<void> | void;
    /** Override clock for deterministic tests. */
    now?: () => Date;
    /** Override the upgrade-check interval (defaults to 6h). Tests
     *  typically set this to 0 to fire the check immediately. */
    intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class UpgradeOrchestrator {
    private readonly intervalMs: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly now: () => Date;
    private shuttingDown = false;

    constructor(private readonly deps: OrchestratorDeps) {
        this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.now = deps.now ?? (() => new Date());
    }

    /** Fire the check once immediately, then schedule periodic rechecks.
     *  Safe to call multiple times — later calls are no-ops so a
     *  `start()` from a hot-reload path doesn't double-schedule. */
    start(): void {
        if (this.timer) return;
        void this.runOnce().catch((err: unknown) => {
            log.error(`upgrade check failed: ${String(err)}`);
        });
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
        // Don't keep the event loop alive solely for the upgrade timer —
        // the daemon has its own keep-alive via the listening sockets.
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** One iteration of the periodic loop. Public so tests can drive it
     *  without waiting for the real interval. */
    async tick(): Promise<void> {
        if (this.shuttingDown) return;
        await this.runOnce();
        if (!this.shuttingDown) {
            this.timer = setTimeout(() => this.tick(), this.intervalMs);
            this.timer.unref?.();
        }
    }

    private async runOnce(): Promise<void> {
        const marker = await readUpgradeMarker(this.deps.markerPath);
        if (!marker) return;
        if (this.deps.liveDir && !sameInstallPath(marker.live_dir, this.deps.liveDir)) {
            // Foreign marker: another installation sharing $TACO_HOME has a
            // pending upgrade. Not ours to honor — and NOT ours to clear:
            // its own daemon will shut down on it and its owner will apply.
            log.debug(
                `ignoring marker for another install (live=${marker.live_dir}, own=${this.deps.liveDir})`,
            );
            return;
        }
        if (!(await stagingExists(marker))) {
            // The staging dir is gone (commonly /tmp cleanup), so this upgrade
            // can never complete. Keeping the marker would re-warn on every
            // boot and every 6h check forever, so clear it and let a future
            // `taco upgrade` re-stage from scratch.
            //
            // Swallow clear failures (read-only fs, EACCES, …) as warnings:
            // we'd rather re-warn next boot than crash the orchestrator and
            // lose the rest of the periodic checks.
            log.warn(
                `marker staging dir missing (${marker.staging_dir}); clearing unusable marker`,
            );
            try {
                await clearUpgradeMarker(this.deps.markerPath);
            } catch (err) {
                log.warn(`failed to clear unusable marker (will retry next boot): ${String(err)}`);
            }
            return;
        }
        log.info(`upgrade pending → ${marker.version}; asking host to shut down`);
        this.shuttingDown = true;
        await this.deps.requestShutdown("upgrade-pending");
    }
}

async function stagingExists(marker: UpgradeMarker): Promise<boolean> {
    try {
        const s = await stat(marker.staging_dir);
        return s.isDirectory();
    } catch {
        return false;
    }
}

/** Default marker path used when the daemon doesn't override. */
export const DEFAULT_MARKER_PATH = join(tacoHome(), "upgrade-marker.json");
