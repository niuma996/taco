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

export const PLATFORM_PKG_PREFIX = "@taco-ai/sidecar-";

/** npm package name for the current platform, e.g. `@taco-ai/sidecar-darwin-arm64`. */
export function currentPlatformPkg(): { key: PlatformKey; pkg: string } {
    const key = currentPlatformKey();
    return { key, pkg: `${PLATFORM_PKG_PREFIX}${key}` };
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
