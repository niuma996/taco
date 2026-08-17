/**
 * Helpers shared by `taco install` / `taco uninstall` — platform-pkg discovery
 * and a small `execFile` wrapper. Platform-specific dispatch (plist rendering,
 * schtasks invocation) lives in `install.ts` / `uninstall.ts` so each file
 * stays under the 1000-line cap.
 *
 * The platform pkg is found the same way `sidecarLauncher.ts`'s prod path
 * does: walk the optional deps via `createRequire` and look for one whose
 * `manifest.json` declares the right Node binary. We do NOT copy the pkg to
 * $TACO_HOME — launchd / schtasks invoke a wrapper that points at the
 * pkg's existing install location, so a `pnpm update` of the platform pkg
 * propagates without re-running `taco install`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Keep in sync with the six platform keys published by release-sidecar.yml
 *  (see scripts/stagePlatformPackages.mjs). Adding a new platform requires
 *  adding a key here AND building a matching bundle in CI. */
const PLATFORM_KEYS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "win32-x64",
    "win32-arm64",
] as const;

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
            return { pkgDir: resources, nodeBin, bundle, resources };
        }
    }

    const req = createRequire(import.meta.url);
    for (const key of PLATFORM_KEYS) {
        try {
            const pkgJsonPath = req.resolve(`@taco-ai/sidecar-${key}/package.json`);
            const pkgDir = dirname(pkgJsonPath);
            const manifestPath = join(pkgDir, "manifest.json");
            if (!existsSync(manifestPath)) continue;
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                target?: string;
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
            return { pkgDir, nodeBin, bundle, resources: pkgDir };
        } catch {
            // not installed / wrong platform — try next
        }
    }
    return null;
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
