/**
 * Default sidecar spawn config — shared by cli / e2e / embedded test scripts.
 *
 *  - Defaults to `tsx packages/sidecar/src/index.ts` (assumes the repo root)
 *  - Override via `TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` env vars
 *  - Caller's `command` / `args` win; repoRoot inference is then skipped
 *  - Caller's `repoRoot` wins; else `TACO_SIDECAR_CWD` env; else `process.cwd()`
 *
 * `repoRoot` is NOT auto-derived from `import.meta.url`; callers pass it.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface SidecarSpawn {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export interface SidecarSpawnOptions {
    /**
     * Explicit sidecar command. If set, `args` must also be passed and repoRoot
     * inference is skipped. Used by npm-installed callers, e.g.
     * `createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] })`.
     */
    command?: string;
    args?: string[];
    repoRoot?: string;
    env?: NodeJS.ProcessEnv;
}

/**
 * Locate tsx's ESM loader so the loader can be imported by node itself.
 *
 * Never spawn the `node_modules/.bin/tsx` shim: on Windows that file is
 * `tsx.cmd`, and Node 22+ refuses to execute `.cmd`/`.bat` directly
 * (CVE-2024-27980). A bare `--import tsx` would instead resolve against the
 * spawn cwd, so the loader is located by path and passed as a file:// URL.
 */
function locateTsxLoader(repoRoot: string): string {
    const fromRepo = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
    if (existsSync(fromRepo)) return fromRepo;
    let dir = import.meta.dirname;
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

/** Default sidecar spawn config. */
export function createDefaultSidecarSpawn(opts?: SidecarSpawnOptions): {
    spawn: SidecarSpawn;
} {
    // Explicit command/args win; repoRoot is skipped (external callers should not pass repoRoot).
    if (opts?.command !== undefined) {
        return {
            spawn: {
                command: opts.command,
                args: opts.args ?? [],
                cwd: opts?.repoRoot ?? process.env.TACO_SIDECAR_CWD ?? process.cwd(),
                env: { ...process.env, ...(opts?.env ?? {}) },
            },
        };
    }
    const repoRoot = opts?.repoRoot ?? process.env.TACO_SIDECAR_CWD ?? process.cwd();
    let command = process.env.TACO_SIDECAR_CMD ?? "tsx";
    let args = (process.env.TACO_SIDECAR_ARGS ?? "packages/sidecar/src/index.ts").split(" ");
    // Windows cannot spawn the extensionless `tsx` bin shim: node_modules/.bin
    // only ships tsx.CMD / tsx.ps1 there, and Node 22 refuses to execute .cmd
    // directly (CVE-2024-27980). Run the loader through node itself instead —
    // the same shape as the CLI's dev launcher. An explicit TACO_SIDECAR_CMD
    // still wins so callers can point at a packaged entry point.
    if (process.platform === "win32" && process.env.TACO_SIDECAR_CMD === undefined) {
        command = process.execPath;
        args = ["--import", pathToFileURL(locateTsxLoader(repoRoot)).href, ...args];
    }
    return {
        spawn: {
            command,
            args,
            cwd: repoRoot,
            env: { ...process.env, ...(opts?.env ?? {}) },
        },
    };
}
