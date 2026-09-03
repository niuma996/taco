/**
 * Locate the sidecar bundle and spawn it with the right env to enter daemon mode.
 *
 * Two launch modes:
 *   - dev (TACO_SIDECAR_DEV=1 or this file is in repo's packages/cli): spawn
 *     `tsx <repo>/packages/sidecar/src/index.ts` so the developer gets hot
 *     reload + TypeScript source.
 *   - prod: locate the platform-specific optional dep
 *     (`@taco-ai/sidecar-<platform>`) via `createRequire`, read its
 *     `manifest.json` to find the node binary + bundle, spawn them.
 *
 * The spawn always sets:
 *   TACO_DAEMON_MODE=1          — bundle listens on sockets instead of stdio
 *   TACO_SOCKET=<path>          — NDJSON socket
 *   TACO_CONTROL_SOCKET=<path>  — control socket
 *   TACO_HOME=<path>            — config / log root
 *   TACO_SIDECAR_RESOURCES=<p>  — agents/ + skills/ root (only prod has bundled resources)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_KEYS } from "./upgradePlatform.ts";

interface LaunchedBundle {
    program: string;
    args: string[];
    cwd?: string;
}

interface BundlePaths {
    nodeBin: string;
    bundle: string;
    resources: string;
    /** `sidecarVersion` from the bundle's manifest.json — the code version a
     *  freshly spawned daemon would report. null when the manifest predates
     *  the field. */
    sidecarVersion: string | null;
}

/** Detect dev mode by walking up from this file looking for pnpm-workspace.yaml.
 *  Returns the repo root (parent of `packages/`) when found, else null.
 *
 *  Exported because three call sites need the same dev/prod discrimination
 *  (`launchSidecar` here, `resolveDaemonResourcesRoot` in start.ts, and
 *  `findPlatformPkg` in installHelpers.ts). Two of them had inlined copies
 *  of this walk, which is how the platform-package assumption drifted apart
 *  after the per-platform optionalDependencies were dropped. */
export function findRepoRoot(): string | null {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** Single source of truth for "this CLI runs from a dev checkout".
 *  `launchSidecar` and `start.ts`'s stale-daemon gate must agree on this —
 *  when they drifted, a dev `taco start` could decide to reuse a daemon the
 *  spawn path was about to replace with tsx source (or vice versa). */
export function isDevCheckout(repoRoot: string | null = findRepoRoot()): boolean {
    return repoRoot !== null && process.env.TACO_SIDECAR_DEV !== "0";
}

/** When the CLI is launched from a development checkout (sibling of `packages/`),
 *  prefer `tsx <repo>/packages/sidecar/src/index.ts` over the bundled platform pkg
 *  so devs see hot-reload + line numbers in stack traces. */
function devLauncher(repoRoot: string): LaunchedBundle {
    const repoTsx = join(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const program = existsSync(repoTsx) ? repoTsx : "tsx";
    return {
        program,
        args: [join(repoRoot, "packages", "sidecar", "src", "index.ts")],
        cwd: repoRoot,
    };
}

/** Locate the @taco-ai/sidecar-<platform>/lib/index.mjs + bundled node binary. */
function prodBundlePaths(): BundlePaths | null {
    const req = createRequire(import.meta.url);
    for (const key of PLATFORM_KEYS) {
        try {
            const pkgJsonPath = req.resolve(`@taco-ai/sidecar-${key}/package.json`);
            const pkgDir = dirname(pkgJsonPath);
            const manifestPath = join(pkgDir, "manifest.json");
            if (!existsSync(manifestPath)) continue;
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                target?: string;
                sidecarVersion?: string;
            };
            const nodeBin = join(
                pkgDir,
                "bin",
                manifest.target?.endsWith("-pc-windows-msvc")
                    ? "taco-sidecar-node.exe"
                    : "taco-sidecar-node",
            );
            if (!existsSync(nodeBin)) continue;
            const bundle = join(pkgDir, "lib", "index.mjs");
            if (!existsSync(bundle)) continue;
            return {
                nodeBin,
                bundle,
                resources: pkgDir,
                sidecarVersion:
                    typeof manifest.sidecarVersion === "string" ? manifest.sidecarVersion : null,
            };
        } catch {
            // not installed / wrong platform — try next
        }
    }
    return null;
}

/** The sidecar code version a prod spawn would run, per the platform
 *  bundle's manifest.json. `start.ts` compares this against a serving
 *  daemon's pid-record version and reaps on mismatch. null in dev checkouts
 *  (no platform pkg) — dev mode reaps unconditionally instead, since the
 *  version string cannot see source edits. */
export function prodSidecarVersion(): string | null {
    return prodBundlePaths()?.sidecarVersion ?? null;
}

export interface LaunchOptions {
    /** NDJSON socket path the bundle should bind. */
    socketPath: string;
    /** Control socket path the bundle should bind. */
    controlSocketPath: string;
    /** TACO_HOME to forward to the bundle. */
    tacoHome: string;
    /** Daemon socket, pid, and lock runtime directory. */
    runtimeDir: string;
    /** Extra env vars to pass through (e.g. PATH, HOME). */
    extraEnv?: Record<string, string>;
    /** When true, force dev mode even if the platform pkg is installed. */
    forceDev?: boolean;
}

export interface LaunchResult {
    child: ChildProcess;
    /** Set to true if the child is running in dev mode (tsx + source). */
    dev: boolean;
}

/** Spawn the sidecar bundle in daemon mode. Returns the child handle so the caller can
 *  forward signals / wait for exit. The child is spawned detached: on POSIX it gets
 *  its own process group (terminal signals aimed at the launcher don't reach the
 *  daemon) and is reparented to init once the launcher exits; on Windows detaching
 *  releases it from the launcher's job object so it outlives the launcher (PR3 wraps
 *  the daemon in a service anyway). */
export function launchSidecar(opts: LaunchOptions): LaunchResult {
    const repoRoot = findRepoRoot();
    const useDev = opts.forceDev === true || isDevCheckout(repoRoot);

    let bundle: LaunchedBundle;
    let resourcesRoot: string | undefined;

    if (useDev && repoRoot) {
        bundle = devLauncher(repoRoot);
        resourcesRoot = join(repoRoot, "packages", "sidecar", "src");
    } else {
        const prod = prodBundlePaths();
        if (!prod) {
            throw new Error(
                "no @taco-ai/sidecar-<platform> bundle installed. " +
                    "Run `pnpm install` on a supported platform " +
                    `(${PLATFORM_KEYS.join(", ")}) or set TACO_SIDECAR_DEV=1.`,
            );
        }
        bundle = { program: prod.nodeBin, args: [prod.bundle] };
        resourcesRoot = prod.resources;
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(opts.extraEnv ?? {}),
        TACO_DAEMON_MODE: "1",
        TACO_SOCKET: opts.socketPath,
        TACO_CONTROL_SOCKET: opts.controlSocketPath,
        TACO_HOME: opts.tacoHome,
        TACO_RUNTIME_DIR: opts.runtimeDir,
        TACO_SIDECAR_RESOURCES: resourcesRoot,
    };

    const child = spawn(bundle.program, bundle.args, {
        cwd: bundle.cwd,
        env,
        // Detached daemon: own process group on POSIX, released from the
        // launcher's job object on Windows. Paired with child.unref() in
        // start.ts so the daemon's lifetime is fully decoupled from whoever
        // ran `taco start`.
        detached: true,
        // Daemon mode: NDJSON goes via the socket, stderr goes to the daemon's
        // own log file (sidecar opens LogFiles at $TACO_HOME/logs/), stdin is
        // ignored (control socket is the inbound path).
        stdio: ["ignore", "ignore", "inherit"],
        // Windows: don't pop a conhost window for the daemon.
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });

    return { child, dev: useDev };
}
