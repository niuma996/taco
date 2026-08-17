/**
 * Path constants for taco CLI / daemon layout under $TACO_HOME.
 *
 * Layout under $TACO_HOME:
 *   run/             # per-session runtime state
 *     sidecar.sock          # NDJSON socket (Unix) — or \\.\pipe\taco-sidecar on Windows
 *     sidecar-ctl.sock      # control socket (Unix) — or \\.\pipe\taco-sidecar-ctl on Windows
 *     sidecar.pid           # daemon pid file (Unix only; written by daemon)
 *   bin/             # launcher wrapper scripts (taco-sidecar-daemon[.cmd])
 *   logs/            # service stdout/stderr targets
 *   staging/         # upgrade staging area
 *   jobs/            # scheduler job definitions
 *   taco.json                # user config
 *   desktop.json             # desktop-only config (sidecar reads via $TACO_HOME)
 *
 * $TACO_HOME resolution matches the sidecar's `tacoHome()` helper so CLI and
 * sidecar agree on the root:
 *   1. $TACO_HOME env (absolute, non-empty)
 *   2. $HOME/.taco
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the absolute $TACO_HOME directory (env > $HOME/.taco). Empty/whitespace env is treated as unset. */
export function resolveTacoHome(): string {
    const raw = process.env.TACO_HOME?.trim();
    if (raw && raw.length > 0) {
        return raw;
    }
    return join(homedir(), ".taco");
}

export const TACO_HOME = resolveTacoHome();
export const RUN_DIR = join(TACO_HOME, "run");
export const BIN_DIR = join(TACO_HOME, "bin");

/** NDJSON socket path. Unix: filesystem path under $TACO_HOME/run. Windows: named pipe. */
export function ndjsonSocketPath(home: string = TACO_HOME): string {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\taco-sidecar";
    }
    return join(home, "run", "sidecar.sock");
}

/** Control socket path. Unix: filesystem path under $TACO_HOME/run. Windows: named pipe. */
export function controlSocketPath(home: string = TACO_HOME): string {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\taco-sidecar-ctl";
    }
    return join(home, "run", "sidecar-ctl.sock");
}

/** Daemon pid file (Unix only; Windows uses service control manager in PR3). */
export const DAEMON_PID_FILE = join(TACO_HOME, "run", "sidecar.pid");

/** Upgrade marker file (PR4). */
export const UPGRADE_MARKER = join(TACO_HOME, "upgrade-marker.json");

/** Logs root — launchd/schtasks redirect the daemon's stdout/stderr here. */
export const LOG_DIR = join(TACO_HOME, "logs");

/** Upgrade staging area — PR4 downloads the new bundle here before swapping. */
export const STAGING_DIR = join(TACO_HOME, "staging");

/** Scheduler job definitions root (PR4). */
export const JOBS_DIR = join(TACO_HOME, "jobs");

/** Create the directory tree under $TACO_HOME that `taco install` + later PRs rely on.
 *  Idempotent (recursive mkdir). Modes are 0o755 so launchd / schtasks can read
 *  the wrapper script but a multi-user system doesn't accidentally inherit
 *  world-writable state. The helper takes an explicit `home` so callers can
 *  override $TACO_HOME for tests / dry-run scenarios. */
export async function ensureDirs(home: string = TACO_HOME): Promise<void> {
    await mkdir(join(home, "run"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "bin"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "logs"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "staging"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "jobs"), { recursive: true, mode: 0o755 });
}
