/**
 * Locate the sidecar bundle and spawn it with the right env to enter daemon mode.
 *
 * Two launch modes:
 *   - dev (TACO_SIDECAR_DEV=1 or this file is in repo's packages/cli): spawn
 *     `node --import tsx/dist/loader.mjs <repo>/packages/sidecar/src/index.ts`
 *     so the developer gets TypeScript source in one process. Never spawn
 *     `tsx/dist/cli.mjs` — that CLI re-forks node without inheriting
 *     windowsHide, which is the console flash on Windows. Never spawn the
 *     `node_modules/.bin/tsx` shim either: on Windows that file is
 *     `tsx.cmd` and Node 22+ rejects it with `spawn EINVAL`.
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORM_KEYS } from "./upgradePlatform.ts";

export interface LaunchedBundle {
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

/** Locate `tsx/dist/loader.mjs` so we can
 *  `spawn(process.execPath, ["--import", loader, entry])`.
 *
 *  In-process loader instead of `tsx/dist/cli.mjs`: the CLI re-forks node
 *  without inheriting windowsHide, which flashes a console on Windows.
 *  Never spawn the `node_modules/.bin/tsx` shim either: on Windows that
 *  file is `tsx.cmd`, and Node 22+ rejects `.cmd`/`.bat` with `spawn EINVAL`
 *  (CVE-2024-27980). */
export function locateTsxLoader(repoRoot: string): string {
    const fromRepo = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
    if (existsSync(fromRepo)) return fromRepo;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const candidate = join(dir, "node_modules", "tsx", "dist", "loader.mjs");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        "tsx loader not found (node_modules/tsx/dist/loader.mjs). Run `pnpm install` in the taco checkout.",
    );
}

/** When the CLI is launched from a development checkout (sibling of `packages/`),
 *  prefer TypeScript source over the bundled platform pkg so devs see line
 *  numbers in stack traces. One process: `--import` the tsx loader rather
 *  than spawning `tsx/dist/cli.mjs`, which re-forks node. */
export function resolveDevLaunch(repoRoot: string): LaunchedBundle {
    const loader = locateTsxLoader(repoRoot);
    // file:// so Node's --import accepts a Windows path with drive letters.
    const loaderUrl = pathToFileURL(loader).href;
    return {
        program: process.execPath,
        args: ["--import", loaderUrl, join(repoRoot, "packages", "sidecar", "src", "index.ts")],
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
 *  releases it from the launcher's job object so it outlives `taco start`.
 *  Paired with `child.unref()` in start.ts. `windowsHide` still applies — the
 *  leftover console was tsx/dist/cli.mjs re-forking node, not DETACHED_PROCESS. */
export function launchSidecar(opts: LaunchOptions): LaunchResult {
    const repoRoot = findRepoRoot();
    const useDev = opts.forceDev === true || isDevCheckout(repoRoot);

    let bundle: LaunchedBundle;
    let resourcesRoot: string | undefined;

    if (useDev && repoRoot) {
        bundle = resolveDevLaunch(repoRoot);
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

    // stdin/stdout stay "ignore" — NDJSON goes via the socket, not stdio.
    //
    // Windows: "inherit" is forbidden with `detached: true` (EINVAL), and a
    // detached child whose stdio handles are all "ignore" does not outlive the
    // launcher, so stderr goes to a file the daemon owns. That fd owns
    // $TACO_HOME/logs/daemon.err.log, so drop TACO_STDERR_LOG too: the Tauri
    // desktop sets it on every spawn path, and the sidecar would answer by
    // installing its own stderr tee against the same file, appending every line
    // twice. One writer owns the file.
    //
    // POSIX keeps the long-standing `inherit` — both the desktop's stderr
    // reader (launch-failure tail, Debug tab, `[taco:llm]` → llm-dump.log) and
    // the sidecar's own tee hang off it, so nothing there needs to move.
    let stderr: "ignore" | "inherit" | number = "inherit";
    if (process.platform === "win32") {
        delete env.TACO_STDERR_LOG;
        stderr = "ignore";
        try {
            const logDir = join(opts.tacoHome, "logs");
            mkdirSync(logDir, { recursive: true });
            stderr = openSync(join(logDir, "daemon.err.log"), "a");
        } catch {
            stderr = "ignore";
        }
    }

    const child = spawn(bundle.program, bundle.args, {
        cwd: bundle.cwd,
        env,
        // Detached daemon: own process group on POSIX, released from the
        // launcher's job object on Windows. Without this on Windows, `taco
        // start` exiting (or the desktop killing the launcher after the
        // socket is ready) takes the sidecar with it — the follower then
        // waits 20s on a pipe that never appears.
        detached: true,
        stdio: ["ignore", "ignore", stderr],
        // Windows: hide the console of this node process. The previous
        // leftover flash was tsx/dist/cli.mjs re-forking a second node
        // that did not inherit this flag — that path is gone (`--import`
        // loader). DETACHED_PROCESS and CREATE_NO_WINDOW can coexist here
        // because we never inherit stdio on Windows.
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });

    // libuv dups the fd into the child, so the parent's copy is dead weight the
    // moment spawn returns — without this every launch on Windows leaks one fd.
    if (typeof stderr === "number") closeSync(stderr);

    return { child, dev: useDev };
}
