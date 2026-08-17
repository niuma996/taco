/**
 * macOS launchd uninstall path for `taco uninstall`.
 *
 * Reverses `installLaunchd`:
 *   1. `launchctl unload` the plist (ignore non-zero — the agent may
 *      already be unloaded after a reboot, and that's fine).
 *   2. `rm -f` the plist file. The wrapper under $TACO_HOME/bin/ stays
 *      in place: re-running `taco install` reuses it.
 *
 * Neither the platform pkg under node_modules nor the daemon binary are
 * touched — operators who want a fully clean slate rm them manually.
 */

import { existsSync, unlinkSync } from "node:fs";
import { execFile } from "./installHelpers.ts";
import { launchdPlistPath } from "./installLaunchd.ts";
import type { UninstallResult } from "./uninstall.ts";

export async function uninstallLaunchd(): Promise<UninstallResult> {
    const plistPath = launchdPlistPath();

    // `launchctl unload` returns non-zero when the agent isn't currently
    // loaded (e.g. user rebooted, then ran uninstall before any session
    // started). That's the desired end state — don't surface it as an error.
    if (existsSync(plistPath)) {
        await execFile("launchctl", ["unload", plistPath], { allowFailure: true });
        try {
            unlinkSync(plistPath);
        } catch {
            // The file was removed between the existsSync check and unlink;
            // another process (or `taco install` racing) cleaned up. Fine.
        }
    }

    return { serviceManager: "launchd" };
}
