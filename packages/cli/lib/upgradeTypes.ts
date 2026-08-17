/**
 * Shared types for the upgrade flow. The on-disk shape MUST match what
 * the sidecar's `packages/sidecar/src/upgrader/types.ts` expects —
 * the marker is the contract between the two packages.
 */

export interface UpgradeMarker {
    /** Target version (e.g. "0.2.0"). Surfaces in the UI's "daemon upgrading" notice. */
    version: string;
    /** Absolute path to the staging dir holding the new bundle contents. */
    staging_dir: string;
    /** Absolute path to the live dir the staging should replace. */
    live_dir: string;
    /** Wall-clock ISO when the marker was written; used for diagnostics only. */
    written_at: string;
}

export interface PackageMetadata {
    name: string;
    version: string;
    dist: {
        tarball: string;
        /** `sha512-<base64>` integrity string, verified against the downloaded bytes. */
        integrity: string;
    };
}

export interface UpgradeResult {
    /** The version that was staged (e.g. "0.2.0"). */
    version: string;
    /** Absolute path to the staging dir. */
    stagingDir: string;
    /** Absolute path the `upgrade --apply` step will swap into. */
    liveDir: string;
}

export interface UpgradeApplyResult {
    /** Version that was just swapped in. */
    version: string;
}
