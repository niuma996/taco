/**
 * Path constants for taco CLI / daemon layout under $TACO_HOME.
 *
 * Shared user data lives under $TACO_HOME. Daemon coordination state lives
 * under $TACO_RUNTIME_DIR when it is set, otherwise $TACO_HOME/run:
 *   runtime/         # socket, control socket, pid, and start lock (Unix)
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

/** Default daemon runtime directory for a user-data home. */
export function defaultRuntimeDir(home: string = TACO_HOME): string {
    return join(home, "run");
}

/** Resolve daemon runtime state independently from the shared user-data home. */
export function resolveTacoRuntimeDir(
    home: string = TACO_HOME,
    runtimeOverride: string | undefined = process.env.TACO_RUNTIME_DIR,
): string {
    const raw = runtimeOverride?.trim();
    return raw && raw.length > 0 ? raw : defaultRuntimeDir(home);
}

/** Current process daemon runtime directory. */
export const RUNTIME_DIR = resolveTacoRuntimeDir();
export const BIN_DIR = join(TACO_HOME, "bin");

/** NDJSON socket path. Unix: filesystem path under the runtime directory. Windows: named pipe. */
export function ndjsonSocketPath(runtimeDir: string = RUNTIME_DIR): string {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\taco-sidecar";
    }
    return join(runtimeDir, "sidecar.sock");
}

/** Control socket path. Unix: filesystem path under the runtime directory. Windows: named pipe. */
export function controlSocketPath(runtimeDir: string = RUNTIME_DIR): string {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\taco-sidecar-ctl";
    }
    return join(runtimeDir, "sidecar-ctl.sock");
}

/** Daemon pid file (Unix only; Windows uses service control manager in PR3). */
export function runtimePidFile(runtimeDir: string = RUNTIME_DIR): string {
    return join(runtimeDir, "sidecar.pid");
}

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
export async function ensureDirs(
    home: string = TACO_HOME,
    runtimeDir: string = resolveTacoRuntimeDir(home),
): Promise<void> {
    await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    await mkdir(join(home, "bin"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "logs"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "staging"), { recursive: true, mode: 0o755 });
    await mkdir(join(home, "jobs"), { recursive: true, mode: 0o755 });
}
