/** Remove the host service registration without deleting runtime files. */

import { uninstallLaunchd as runUninstallLaunchd } from "./uninstallLaunchd.ts";
import { uninstallSchtasks as runUninstallSchtasks } from "./uninstallSchtasks.ts";

export interface UninstallOptions {
    /** Override $TACO_HOME (defaults to env / ~/.taco). */
    tacoHome?: string;
}

export interface UninstallResult {
    /** Service manager that was asked to drop the daemon. */
    serviceManager: "launchd" | "schtasks" | "none";
}

/** Top-level entry point for `taco uninstall`. */
export async function uninstallCommand(): Promise<UninstallResult> {
    if (process.platform === "darwin") {
        return runUninstallLaunchd();
    }
    if (process.platform === "win32") {
        return runUninstallSchtasks();
    }
    return { serviceManager: "none" };
}
