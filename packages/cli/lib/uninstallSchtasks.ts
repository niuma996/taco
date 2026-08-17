/**
 * Windows schtasks uninstall path for `taco uninstall`.
 *
 * Reverses `installSchtasks`:
 *   1. `schtasks /Delete /TN TacoSidecar /F` — ignore non-zero (the task
 *      may already be gone after a manual cleanup).
 *   2. Wrapper script under $TACO_HOME\bin\ stays in place: re-running
 *      `taco install` reuses it.
 *
 * Neither the platform pkg under node_modules nor the daemon binary are
 * touched — operators who want a fully clean slate rm them manually.
 */

import { execFile } from "./installHelpers.ts";
import { SCHTASKS_NAME } from "./installSchtasks.ts";
import type { UninstallResult } from "./uninstall.ts";

export async function uninstallSchtasks(): Promise<UninstallResult> {
    // `schtasks /Delete` returns non-zero when the task doesn't exist
    // (e.g. user never ran `taco install`, or already cleaned up). That's
    // the desired end state — don't surface it as an error.
    await execFile("schtasks", ["/Delete", "/TN", SCHTASKS_NAME, "/F"], { allowFailure: true });

    return { serviceManager: "schtasks" };
}
