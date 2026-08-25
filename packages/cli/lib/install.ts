/** Register the sidecar daemon with the host's per-user service manager.
 *  Linux is unsupported because no single user-level manager covers the
 *  supported distro matrix without administrator setup. */

import { findPlatformPkg, type PlatformPkgPaths } from "./installHelpers.ts";
import { installLaunchd as runInstallLaunchd } from "./installLaunchd.ts";
import { installSchtasks as runInstallSchtasks } from "./installSchtasks.ts";
import {
    controlSocketPath,
    defaultRuntimeDir,
    ensureDirs,
    ndjsonSocketPath,
    TACO_HOME,
} from "./paths.ts";

export interface InstallOptions {
    /** Override $TACO_HOME (defaults to env / ~/.taco). */
    tacoHome?: string;
}

export interface InstallResult {
    /** Service manager that ended up owning the daemon. */
    serviceManager: "launchd" | "schtasks";
    /** Absolute path to the wrapper script the service invokes. */
    wrapperPath: string;
    /** Absolute path to the launchd plist (macOS only). */
    plistPath?: string;
    /** Name of the schtasks task (Windows only). */
    taskName?: string;
}

interface PlatformPaths {
    tacoHome: string;
    pkg: PlatformPkgPaths;
    /** NDJSON socket path the wrapper will export as TACO_SOCKET. */
    socket: string;
    /** Control socket path the wrapper will export as TACO_CONTROL_SOCKET. */
    control: string;
}

/** Top-level entry point for `taco install`. Throws on unsupported platforms
 *  or when no platform pkg is installed (the CLI surfaces the message). */
export async function installCommand(opts: InstallOptions = {}): Promise<InstallResult> {
    const tacoHome = opts.tacoHome ?? TACO_HOME;
    // Installed services always own the release runtime, not a caller's
    // debug-only TACO_RUNTIME_DIR override.
    const runtimeDir = defaultRuntimeDir(tacoHome);
    await ensureDirs(tacoHome, runtimeDir);

    const pkg = findPlatformPkg();
    if (!pkg) {
        throw new Error(
            "no @taco-ai/sidecar-<platform> bundle installed. " +
                "Run `pnpm install` on a supported platform to install the " +
                "optional dep, then retry `taco install`.",
        );
    }
    // Stale-bundle guard: a pre-daemon bundle will boot into stdio mode,
    // launchd will keep "running" it (exit 0 keeps KeepAlive happy), and
    // the desktop's hello wait times out 5s later with no useful breadcrumb.
    // Fail fast here so the fix (rebuild + reinstall) is obvious instead of
    // buried in a silent daemon that never opens its socket.
    if (!pkg.daemonMode) {
        throw new Error(
            `stale sidecar bundle at ${pkg.bundle}: missing daemon-mode support. ` +
                "Rebuild the runtime (`pnpm --filter @taco-ai/sidecar package:runtime`) " +
                "and re-run `taco install`.",
        );
    }

    const paths: PlatformPaths = {
        tacoHome,
        pkg,
        socket: ndjsonSocketPath(runtimeDir),
        control: controlSocketPath(runtimeDir),
    };

    if (process.platform === "darwin") {
        return runInstallLaunchd({ ...paths, logDir: `${tacoHome}/logs` });
    }
    if (process.platform === "win32") {
        return runInstallSchtasks({ ...paths });
    }
    throw new Error(`unsupported platform: ${process.platform}`);
}
