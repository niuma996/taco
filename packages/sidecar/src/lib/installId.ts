import { createHash } from "node:crypto";

/** Stable identifier for one taco install on one machine.
 *
 *  Sibling installs can share one `$TACO_HOME`, so the id must separate them.
 *  Two anchors are hashed: `resourcesRoot` (this installation's bundle dir)
 *  and `tacoHome` (so a relocatable install stays unique even if its
 *  resources dir is symlinked).
 *
 *  The CLI has a duplicate implementation (`packages/cli/lib/installId.ts`) —
 *  both sides must agree, else the desktop reap path skips a daemon it owns
 *  or kills one it doesn't. */
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
