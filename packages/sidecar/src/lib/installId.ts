import { createHash } from "node:crypto";

/** Stable identifier for one taco install on one machine.
 *
 *  The desktop sidecar (and the CLI launcher) needs a way to distinguish a
 *  daemon it started from a daemon started by a sibling taco install that
 *  happens to share `$TACO_HOME` (npm global + desktop app pointing at the
 *  same home, dev repo source running alongside a release bundle, etc.).
 *
 *  We hash the two anchors that uniquely identify an install:
 *    - `resourcesRoot` — the bundle directory shipped with this installation.
 *      Two different installs of the same platform always have different
 *      resources roots even when they share `$TACO_HOME`.
 *    - `tacoHome` — included as a second anchor so a relocatable install
 *      (e.g. an admin-packaged taco in `/opt`) still gets a unique id even
 *      if some tooling happens to symlink the resources dir.
 *
 *  The 16-hex prefix is the same width the sidecar uses for the checkpoint
 *  workspace key — short enough to fit comfortably in the pid file, long
 *  enough that collisions in any realistic single-user install setup are
 *  effectively impossible (64 bits of entropy).
 *
 *  Pure function so it's testable without any environment side effects.
 *  The CLI side has a duplicate implementation (see
 *  `packages/cli/lib/installId.ts`) — both sides must agree, otherwise the
 *  desktop reap path would skip a daemon it owns (or kill one it doesn't). */
export function computeInstallId(resourcesRoot: string, tacoHome: string): string {
    const h = createHash("sha256");
    h.update(resourcesRoot);
    h.update("\0");
    h.update(tacoHome);
    return h.digest("hex").slice(0, 16);
}

/** Shape of the JSON the daemon writes to `dirname($TACO_SOCKET)/sidecar.pid`
 *  (i.e. the daemon runtime directory, not necessarily `$TACO_HOME/run`).
 *  Versioned so future format changes can detect old files and either
 *  upgrade or replace them rather than silently misparse. */
export interface SidecarPidRecord {
    /** Schema version. Bump on any field rename/remove. */
    version: 1;
    /** Daemon pid. Same value as `process.pid` at write time. */
    pid: number;
    /** Install id produced by `computeInstallId`. */
    install_id: string;
    /** ISO-8601 timestamp of when the daemon bound both sockets. */
    started_at: string;
    /** Sidecar code version the daemon is running (`sidecarVersion()`).
     *  Optional: additive within schema v1. Launchers compare it against the
     *  version they would spawn and reap on mismatch, so a stale daemon is
     *  never reused after an upgrade. Absent on records written by daemons
     *  that predate the field — those always compare stale. */
    sidecar_version?: string;
}

/** Build the pid-file payload. Caller serialises — kept as a pure function
 *  so the same shape can be reused by the installId unit test fixtures. */
export function buildSidecarPidRecord(
    pid: number,
    installId: string,
    sidecarVersion?: string,
    now: () => Date = () => new Date(),
): SidecarPidRecord {
    return {
        version: 1,
        pid,
        install_id: installId,
        started_at: now().toISOString(),
        ...(sidecarVersion !== undefined ? { sidecar_version: sidecarVersion } : {}),
    };
}
