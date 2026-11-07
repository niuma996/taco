/**
 * Daemon-side upgrade orchestrator.
 *
 * Contract: `taco upgrade` stages a bundle and writes an upgrade marker; the
 * daemon sees the marker on boot and every 6h and asks its host to shut down.
 * The UI's reconnect loop then runs `taco upgrade --apply`, which swaps the
 * staged bundle into the live dir and relaunches.
 *
 * We don't restart ourselves — before the swap lands, a respawn would just
 * come back on the old version — and don't push a server event (ServerPush
 * frames are workspace-scoped).
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
