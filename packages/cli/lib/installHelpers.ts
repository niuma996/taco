/**
 * Helpers shared by `taco install` / `taco uninstall` — platform-pkg discovery
 * and a small `execFile` wrapper. Platform-specific dispatch (plist rendering,
 * schtasks invocation) lives in `install.ts` / `uninstall.ts` so each file
 * stays under the 1000-line cap.
 *
 * Resolution order, first match wins:
 *   1. TACO_SIDECAR_NODE / _BUNDLE / _RESOURCES env triple — explicit override.
 *   2. An installed `@taco-ai/sidecar-<platform>` package, located via
 *      `createRequire` and validated against its `manifest.json`. This is the
 *      released path.
 *   3. Dev checkout: `packages/sidecar/dist/runtime/<triple>/`, which
 *      `buildRuntime.mjs` emits with the same layout as the platform package
 *      (`lib/index.mjs`, `bin/taco-sidecar-node`, `agents/`, `skills/`,
 *      `manifest.json`). Needed because the per-platform optionalDependencies
 *      were dropped from the sidecar manifest, so a dev checkout has no
 *      platform package to resolve at (2).
 *
 * We do NOT copy the resolved tree to $TACO_HOME — launchd / schtasks invoke a
 * wrapper pointing at its existing location. For (2) that means a `pnpm update`
 * propagates without re-running `taco install`; for (3) a `package:runtime`
 * rebuild propagates the same way. The tradeoff is that deleting the resolved
 * tree (`rm -rf node_modules`, wiping `dist/`) leaves the wrapper dangling until
 * `taco install` re-runs.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findRepoRoot } from "./sidecarLauncher.ts";
import { currentTriple, PLATFORM_KEYS } from "./upgradePlatform.ts";

export interface PlatformPkgPaths {
    /** Absolute path to the @taco-ai/sidecar-<platform>/ package directory. */
    pkgDir: string;
    /** Absolute path to the bundled `taco-sidecar-node` (or .exe on Windows). */
    nodeBin: string;
    /** Absolute path to the bundled sidecar entry (`lib/index.mjs`). */
    bundle: string;
    /** Absolute path that should be exported as TACO_SIDECAR_RESOURCES — the
     *  directory containing `agents/` and `skills/`. Currently equals pkgDir. */
    resources: string;
    /** True when the bundle was built with daemon-mode support (manifest
     *  advertises `daemonMode: true`). A missing/false value means the
     *  bundle is stale (pre-daemon) — `taco install` must refuse to
     *  register a daemon that will silently boot into stdio mode. */
    daemonMode: boolean;
}

/** Locate the @taco-ai/sidecar-<platform>/lib/index.mjs + bundled node binary.
 *  Returns null when no matching pkg is installed (the caller surfaces a
 *  clear error — install needs the bundle, dev mode does not). */
export function findPlatformPkg(): PlatformPkgPaths | null {
    const configured = [
        process.env.TACO_SIDECAR_NODE,
        process.env.TACO_SIDECAR_BUNDLE,
        process.env.TACO_SIDECAR_RESOURCES,
    ];
    if (configured.every((value) => value !== undefined)) {
        const [nodeBin, bundle, resources] = configured as [string, string, string];
        if (existsSync(nodeBin) && existsSync(bundle)) {
            // Env override: no manifest to consult, so grep the bundle
            // directly. Slow (~4MB read) but install is not hot-path.
            return {
                pkgDir: resources,
                nodeBin,
                bundle,
                resources,
                daemonMode: bundleHasDaemonMode(bundle),
            };
        }
    }

    const req = createRequire(import.meta.url);
    for (const key of PLATFORM_KEYS) {
        let pkgDir: string;
        try {
            pkgDir = dirname(req.resolve(`@taco-ai/sidecar-${key}/package.json`));
        } catch {
            continue; // not installed / wrong platform — try next
        }
        const probed = probePkgDir(pkgDir);
        if (probed) return probed;
    }

    // Dev checkout fallback. `buildRuntime.mjs` emits dist/runtime/<triple>/ with
    // the same layout the platform package ships, so the wrapper can point
    // straight at it and skip the staging copy entirely.
    const repoRoot = findRepoRoot();
    if (repoRoot !== null) {
        const distDir = join(repoRoot, "packages", "sidecar", "dist", "runtime", currentTriple());
        const probed = probePkgDir(distDir);
        if (probed) return probed;
    }
    return null;
}

/** Validate a directory that claims to hold a sidecar runtime and lift it into
 *  `PlatformPkgPaths`. Returns null when any required artifact is missing, so
 *  callers can fall through to the next resolution strategy. Shared by the
 *  platform-package and dev-checkout branches — they differ only in how the
 *  directory is located, not in what makes it valid.
 *
 *  Exported for unit tests; production callers should reach for
 *  `findPlatformPkg`, which applies the three resolution strategies in order. */
export function probePkgDir(pkgDir: string): PlatformPkgPaths | null {
    const manifestPath = join(pkgDir, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    let manifest: { target?: string; daemonMode?: boolean };
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    } catch {
        return null;
    }
    const nodeBin = join(
        pkgDir,
        "bin",
        manifest.target?.endsWith("-pc-windows-msvc")
            ? "taco-sidecar-node.exe"
            : "taco-sidecar-node",
    );
    if (!existsSync(nodeBin)) return null;
    const bundle = join(pkgDir, "lib", "index.mjs");
    if (!existsSync(bundle)) return null;
    const daemonMode = manifest.daemonMode === true ? true : bundleHasDaemonMode(bundle);
    return { pkgDir, nodeBin, bundle, resources: pkgDir, daemonMode };
}

/** Cheap daemon-mode probe: read the bundle and look for the env var the
 *  runtime gates on. Older manifests lack the `daemonMode` field, so
 *  install must fall back to this rather than reject. Bundle read is
 *  ~4MB — fine for `taco install`, not something to do per-RPC. Exported
 *  for unit tests; production callers should reach for `findPlatformPkg`
 *  which consults the manifest first. */
export function bundleHasDaemonMode(bundlePath: string): boolean {
    try {
        return readFileSync(bundlePath, "utf8").includes("TACO_DAEMON_MODE");
    } catch {
        return false;
    }
}

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run an external command and capture its output. Rejects on non-zero exit
 *  unless `opts.allowFailure` is true (used by `uninstall` for `launchctl
 *  unload` — it returns non-zero when the agent isn't loaded, which is fine). */
export function execFile(
    program: string,
    args: readonly string[],
    opts: { allowFailure?: boolean } = {},
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => errChunks.push(c));
        child.once("error", (err) => reject(err));
        child.once("close", (code) => {
            const stdout = Buffer.concat(chunks).toString("utf8");
            const stderr = Buffer.concat(errChunks).toString("utf8");
            const result: ExecResult = { code: code ?? -1, stdout, stderr };
            if (code === 0 || opts.allowFailure === true) {
                resolve(result);
            } else {
                reject(new Error(`${program} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
            }
        });
    });
}
