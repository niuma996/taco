/**
 * Upgrade-marker types — the on-disk contract between the CLI's
 * `taco upgrade` command (which downloads a new bundle into staging
 * + writes the marker) and the daemon's self-upgrade orchestrator
 * (which reads the marker, broadcasts the notice, and exits so the
 * service manager restarts the daemon against the new files).
 *
 * The marker is plain JSON; an absent or malformed file means "no
 * pending upgrade" and the orchestrator treats it as a no-op. This
 * matches the `JobStore` policy of skipping malformed files rather
 * than wedging on them — operator-visible errors should surface
 * from the CLI that wrote the marker, not from the daemon reading it.
 */

export interface UpgradeMarker {
    /** Target version (e.g. "0.2.0"). Used in the UI's "daemon upgrading" notice. */
    version: string;
    /** Absolute path to the staging dir holding the new bundle contents. */
    staging_dir: string;
    /** Absolute path to the live dir the staging should replace. */
    live_dir: string;
    /** Wall-clock ISO when the marker was written; used for diagnostics only. */
    written_at: string;
}
