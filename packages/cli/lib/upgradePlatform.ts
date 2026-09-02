/**
 * Map the current process platform + arch to the npm package name suffix
 * matching `release-sidecar.yml`'s matrix. The list MUST stay in sync
 * with `packages/cli/lib/installHelpers.ts`'s PLATFORM_KEYS (and the
 * six optional deps in `packages/sidecar/package.json`).
 */

export const PLATFORM_KEYS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "win32-x64",
    "win32-arm64",
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/** Node platform-arch key → Rust target triple, naming the `dist/runtime/<triple>/`
 *  directory `buildRuntime.mjs` emits. Mirrors `FROM_PROCESS` in
 *  `packages/sidecar/scripts/triple.mjs`; duplicated rather than imported because
 *  the CLI must not reach into the sidecar's scripts/ dir. The `Record<PlatformKey, …>`
 *  type is load-bearing: adding a platform to PLATFORM_KEYS without a triple here
 *  becomes a compile error instead of a runtime `undefined` path. */
const TRIPLE_BY_KEY: Record<PlatformKey, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
};

export const PLATFORM_PKG_PREFIX = "@taco-ai/sidecar-";

/** npm package name for the current platform, e.g. `@taco-ai/sidecar-darwin-arm64`. */
export function currentPlatformPkg(): { key: PlatformKey; pkg: string } {
    const key = currentPlatformKey();
    return { key, pkg: `${PLATFORM_PKG_PREFIX}${key}` };
}

/** Rust target triple for the current host, e.g. `aarch64-apple-darwin`. Names the
 *  `packages/sidecar/dist/runtime/<triple>/` tree a dev checkout builds. */
export function currentTriple(): string {
    return TRIPLE_BY_KEY[currentPlatformKey()];
}

export function currentPlatformKey(): PlatformKey {
    const platform = process.platform;
    const arch = process.arch;
    const key = `${platform}-${arch}`;
    if ((PLATFORM_KEYS as readonly string[]).includes(key)) {
        return key as PlatformKey;
    }
    throw new Error(
        `unsupported platform ${platform}/${arch} (known: ${PLATFORM_KEYS.join(", ")})`,
    );
}
