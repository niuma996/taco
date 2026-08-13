/**
 * Runtime resource / version / extension root resolution — works for bundled and
 * source (tsx) builds. `import.meta.dirname` relative paths break after bundling,
 * so the three "roots" are resolved centrally here.
 * ⚠ MUST live exactly one level below src/ (src/runtime/).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";

// esbuild `--define:__TACO_SIDECAR_VERSION__` injects this global at bundle time.
// Use `typeof` to narrow, not `declare const`: declare would lie to emit and
// ReferenceError on a bare reference if missing; typeof guard safely falls
// back in source form where the identifier is absent.
declare const __TACO_SIDECAR_VERSION__: unknown;

/**
 * Sidecar resource root (parent of agents/ and skills/).
 * Priority: TACO_SIDECAR_RESOURCES env > import.meta.dirname one level up.
 * Desktop release explicitly sets the env to the Tauri resource dir;
 * source/bundle default to the layout convention.
 */
export function resourceRoot(): string {
    if (process.env.TACO_SIDECAR_RESOURCES) return process.env.TACO_SIDECAR_RESOURCES;
    return join(import.meta.dirname, "..");
}

/**
 * Sidecar version, authoritatively `packages/sidecar/package.json`.
 * Bundles inline it via esbuild --define, so the `typeof` branch returns before
 * ever reaching the read below — dist ships no package.json, and that read must
 * stay unreachable there. Source form has no such identifier and reads
 * package.json, which keeps `taco/<version>` honest while running under tsx.
 */
export function sidecarVersion(): string {
    if (typeof __TACO_SIDECAR_VERSION__ === "string") return __TACO_SIDECAR_VERSION__;
    return readPackageVersion();
}

let packageVersion: string | undefined;

function readPackageVersion(): string {
    if (packageVersion !== undefined) return packageVersion;
    try {
        const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
        packageVersion = typeof pkg.version === "string" ? pkg.version : UNKNOWN_VERSION;
    } catch {
        packageVersion = UNKNOWN_VERSION;
    }
    return packageVersion;
}

const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * require resolution root for npm extensions. Bundled release ships no
 * node_modules, so the default points to `$TACO_HOME/extensions`;
 * TACO_EXTENSION_ROOT can override for tests/deploy.
 *
 * ⚠ Don't confuse with TACO_EXTENSIONS_DIR:
 *   - TACO_EXTENSION_ROOT (singular): createRequire resolution root for npm extensions
 *   - TACO_EXTENSIONS_DIR (plural): scan root for directory-form extensions
 * Both default to `$TACO_HOME/extensions` but have distinct semantics.
 */
export function extensionRequireRoot(): string {
    if (process.env.TACO_EXTENSION_ROOT) return process.env.TACO_EXTENSION_ROOT;
    return join(tacoHome(), "extensions");
}
