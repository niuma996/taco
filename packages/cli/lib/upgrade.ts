/**
 * `taco upgrade` — fetch the latest sidecar bundle for the current
 * platform from the npm registry, verify integrity, extract to staging,
 * and write the upgrade marker so the daemon's orchestrator can shut
 * itself down on its next recheck.
 *
 * Why npm registry (not GitHub Releases):
 *   release-sidecar.yml publishes platform pkgs to `@taco-ai/sidecar-<plat>`
 *   on npm; GitHub Releases aren't part of the v0.1.0 pipeline. The npm
 *   registry is the source of truth, supports anonymous GETs, and ships
 *   an `integrity` (sha512-base64) field we verify against the
 *   downloaded bytes. PR5 may add minisign signatures over the same
 *   tarball as a second layer; the integrity check stays as a floor.
 *
 * Layout on disk after a successful run:
 *   $TACO_HOME/cache/sidecar/<platform>-<version>.tgz     downloaded tarball
 *   $TACO_HOME/staging/sidecar-<platform>-<version>/      extracted bundle
 *   $TACO_HOME/upgrade-marker.json                        the marker
 *
 * The daemon's UpgradeOrchestrator reads the marker on its 6h recheck,
 * sees the staging dir exists, and asks the host to shut down. The UI's
 * reconnect loop then runs `taco upgrade --apply` (commit 6's companion)
 * which swaps staging into live and restarts.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extract } from "tar";
import { STAGING_DIR, TACO_HOME } from "./paths.ts";
import { createLogger } from "./upgradeLogger.ts";
import { writeUpgradeMarker } from "./upgradeMarker.ts";
import { currentPlatformPkg } from "./upgradePlatform.ts";
import type { PackageMetadata, UpgradeMarker, UpgradeResult } from "./upgradeTypes.ts";

const log = createLogger("taco.cli.upgrade");

const NPM_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 30_000;

/** Test/CLI seam — replace `fetch` to inject canned responses. */
export type Fetcher = typeof fetch;

export interface UpgradeOptions {
    /** Override `fetch` (tests inject a fake here). */
    fetcher?: Fetcher;
    /** Override `$TACO_HOME` (defaults to env / ~/.taco). */
    tacoHome?: string;
    /** Override version (`"latest"` by default; tests pin a specific version). */
    version?: string;
    /** Override platform key (tests pin to `darwin-arm64` etc.). */
    platformKey?: string;
    /** Override the npm registry URL (for tests + private registries). */
    registry?: string;
    /** Override the current install's pkgDir (tests pin to a tmpdir). */
    liveDirOverride?: string;
}

/** Fetch the npm metadata doc for `pkg@version`. */
async function fetchMetadata(
    registry: string,
    pkg: string,
    version: string,
    fetcher: Fetcher,
): Promise<PackageMetadata> {
    const url =
        version === "latest" ? `${registry}/${pkg}/latest` : `${registry}/${pkg}/${version}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetcher(url, { signal: controller.signal });
        if (!res.ok) {
            throw new Error(
                `registry returned ${res.status} ${res.statusText} for ${pkg}@${version}`,
            );
        }
        return (await res.json()) as PackageMetadata;
    } finally {
        clearTimeout(timer);
    }
}

/** Stream a URL into `dest` and return the total bytes written. Throws
 *  on non-2xx; the caller decides whether to retry. */
async function downloadToFile(url: string, dest: string, fetcher: Fetcher): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetcher(url, { signal: controller.signal });
        if (!res.ok) {
            throw new Error(`tarball download ${res.status} ${res.statusText} for ${url}`);
        }
        if (!res.body) throw new Error(`tarball response had no body for ${url}`);
        await mkdir(dirname(dest), { recursive: true });
        const file = await open(dest, "w");
        try {
            let total = 0;
            const reader = res.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await file.write(value);
                total += value.byteLength;
            }
            return total;
        } finally {
            await file.close();
        }
    } finally {
        clearTimeout(timer);
    }
}

/** Verify the downloaded file against `sha512-<base64>`. Throws on mismatch. */
async function verifyIntegrity(filePath: string, integrity: string): Promise<void> {
    const [algo, expected] = integrity.split("-");
    if (algo !== "sha512") {
        throw new Error(`unsupported integrity algorithm: ${algo}`);
    }
    const hash = createHash("sha512");
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve());
        stream.on("error", reject);
    });
    const actual = hash.digest("base64");
    if (actual !== expected) {
        throw new Error(`integrity mismatch: expected ${expected}, got ${actual}`);
    }
}

/** Top-level entry point for `taco upgrade`. Throws on any failure; the
 *  CLI dispatcher's `.catch` surfaces the message + exits non-zero. */
export async function upgradeCommand(opts: UpgradeOptions = {}): Promise<UpgradeResult> {
    const fetcher: Fetcher = opts.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
        throw new Error("global fetch is not available; pass opts.fetcher explicitly");
    }
    const tacoHome = opts.tacoHome ?? TACO_HOME;
    const registry = opts.registry ?? NPM_REGISTRY;
    const platform = opts.platformKey
        ? {
              key: opts.platformKey as ReturnType<typeof currentPlatformPkg>["key"],
              pkg: `@taco-ai/sidecar-${opts.platformKey}`,
          }
        : currentPlatformPkg();
    const version = opts.version ?? "latest";

    log.info(`fetching metadata for ${platform.pkg}@${version}`);
    const metadata = await fetchMetadata(registry, platform.pkg, version, fetcher);
    if (!metadata.dist?.tarball || !metadata.dist?.integrity) {
        throw new Error(
            `registry response missing dist.tarball/integrity for ${platform.pkg}@${version}`,
        );
    }

    // Use the resolved version (not "latest") for the on-disk layout so
    // re-running upgrade picks up the same staging dir rather than racing.
    const resolvedVersion = metadata.version;
    const resolvedStagingDir = join(
        tacoHome,
        "staging",
        `sidecar-${platform.key}-${resolvedVersion}`,
    );
    const tarballPath = join(
        tacoHome,
        "cache",
        "sidecar",
        `sidecar-${platform.key}-${resolvedVersion}.tgz`,
    );

    log.info(`downloading tarball → ${tarballPath}`);
    await mkdir(dirname(tarballPath), { recursive: true });
    await downloadToFile(metadata.dist.tarball, tarballPath, fetcher);

    log.info("verifying integrity");
    await verifyIntegrity(tarballPath, metadata.dist.integrity);

    // Wipe any prior staging dir for this version (interrupted prior run).
    await rm(resolvedStagingDir, { recursive: true, force: true });
    await mkdir(resolvedStagingDir, { recursive: true });

    log.info(`extracting → ${resolvedStagingDir}`);
    await extract({
        file: tarballPath,
        cwd: resolvedStagingDir,
        // npm tarballs wrap everything in a single `package/` top-level dir;
        // strip it so the staging layout matches the platform pkg's expected
        // shape (manifest.json + bin/ + lib/).
        strip: 1,
    });

    // Sanity-check the extracted dir has the bundle's expected files; a
    // tarball that extracted but is missing manifest.json would be an
    // operator-confusing silent failure downstream.
    await assertBundleShape(resolvedStagingDir);

    const liveDir = opts.liveDirOverride ?? (await resolveLiveDir(platform.key));
    if (!liveDir) {
        throw new Error(
            `no current @taco-ai/sidecar-${platform.key} install found; run 'taco install' first`,
        );
    }

    const marker: UpgradeMarker = {
        version: resolvedVersion,
        staging_dir: resolvedStagingDir,
        live_dir: liveDir,
        written_at: new Date().toISOString(),
    };
    const markerPath = join(tacoHome, "upgrade-marker.json");
    await writeUpgradeMarker(markerPath, marker);

    log.info(`upgrade staged → version=${resolvedVersion}, marker=${markerPath}`);
    return {
        version: resolvedVersion,
        stagingDir: resolvedStagingDir,
        liveDir,
    };
}

async function assertBundleShape(stagingDir: string): Promise<void> {
    for (const relative of ["manifest.json", "bin", "lib"]) {
        const target = join(stagingDir, relative);
        try {
            await stat(target);
        } catch {
            throw new Error(`staged bundle missing ${relative} at ${target}`);
        }
    }
}

/** Resolve the current install's pkgDir for `platformKey`. Mirrors
 *  `installHelpers.findPlatformPkg` but for the CLI side; we re-resolve
 *  here because the staging flow doesn't have access to the sidecar's
 *  installed tree state. */
async function resolveLiveDir(platformKey: string): Promise<string | null> {
    // createRequire from this module's URL so the CLI package's own
    // node_modules tree is consulted — that's where the platform pkg
    // resolves (the CLI depends on `@taco-ai/sidecar` which hoists
    // its optional deps into the same workspace).
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    try {
        const pkgJsonPath = req.resolve(`@taco-ai/sidecar-${platformKey}/package.json`);
        const idx = pkgJsonPath.lastIndexOf("/package.json");
        return idx < 0 ? pkgJsonPath : pkgJsonPath.slice(0, idx);
    } catch {
        return null;
    }
}

// Re-export so tests can poke at the staging/live dir constants without
// re-importing from paths.ts (which is shared with unrelated modules).
export const _INTERNAL_STAGING_DIR = STAGING_DIR;
export const _INTERNAL_TACO_HOME = TACO_HOME;
