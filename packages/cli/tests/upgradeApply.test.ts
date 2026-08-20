/**
 * `taco upgrade --apply` integration tests. Builds staging + live dirs
 * in a tmpdir, writes a marker, drives `upgradeApplyCommand`, asserts
 * the atomic swap landed + marker cleared + rollback path triggers.
 */

import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { upgradeApplyCommand } from "../lib/upgradeApply.ts";
import { readUpgradeMarker, writeUpgradeMarker } from "../lib/upgradeMarker.ts";
import type { UpgradeMarker } from "../lib/upgradeTypes.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-cli-apply-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Lay out a staging dir that passes the bundle-shape check. */
async function writeBundleShape(dir: string, version: string): Promise<void> {
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({ target: "aarch64-apple-darwin", version }),
        "utf8",
    );
    await writeFile(join(dir, "bin", "taco-sidecar-node"), "new", "utf8");
    await writeFile(join(dir, "lib", "index.mjs"), "// new bundle", "utf8");
}

async function writeLiveShape(dir: string): Promise<void> {
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({ target: "aarch64-apple-darwin", version: "0.1.0" }),
        "utf8",
    );
    await writeFile(join(dir, "bin", "taco-sidecar-node"), "old", "utf8");
    await writeFile(join(dir, "lib", "index.mjs"), "// old bundle", "utf8");
}

test("upgradeApplyCommand swaps staging into live + clears marker", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        const marker: UpgradeMarker = {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        };
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), marker);

        const result = await upgradeApplyCommand({ tacoHome: home });
        strictEqual(result.version, "0.2.0");

        // Live now has the new contents.
        const newManifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(newManifest.version, "0.2.0");
        const newBundle = await readFile(join(live, "lib", "index.mjs"), "utf8");
        strictEqual(newBundle.trim(), "// new bundle");

        // Marker is cleared.
        ok(!(await readUpgradeMarker(join(home, "upgrade-marker.json"))));

        // Rollback target removed.
        await rejects(readFile(`${live}.prev/manifest.json`, "utf8"), /ENOENT/);
    });
});

test("upgradeApplyCommand throws when marker is missing", async () => {
    await withTmp(async (home) => {
        await rejects(upgradeApplyCommand({ tacoHome: home }), /no upgrade pending/);
    });
});

test("upgradeApplyCommand refuses to swap when staging is missing manifest.json", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await mkdir(staging, { recursive: true });
        await writeLiveShape(live);
        // Don't write manifest.json in staging.
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        await rejects(upgradeApplyCommand({ tacoHome: home }), /staging dir missing manifest.json/);

        // Live must still hold the old contents (no half-swap).
        const manifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(manifest.version, "0.1.0");
        ok(await readUpgradeMarker(join(home, "upgrade-marker.json")));
    });
});

test("upgradeApplyCommand clears stale .prev from a prior failed swap", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        const prevDir = `${live}.prev`;
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        // Plant a stale .prev from a prior failed swap.
        await mkdir(prevDir, { recursive: true });
        await writeFile(join(prevDir, "manifest.json"), "{}", "utf8");

        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        await upgradeApplyCommand({ tacoHome: home });

        // The stale .prev got overwritten with the old live contents (then
        // deleted at the end), so it must not exist now.
        await rejects(readFile(join(prevDir, "manifest.json"), "utf8"), /ENOENT/);
    });
});

test("upgradeApplyCommand invokes stop hook (best-effort) after swap", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        let stopCalls = 0;
        await upgradeApplyCommand({
            tacoHome: home,
            stop: async () => {
                stopCalls += 1;
            },
        });
        strictEqual(stopCalls, 1);
    });
});

test("upgradeApplyCommand swallows stop-hook errors (best-effort)", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        await upgradeApplyCommand({
            tacoHome: home,
            stop: async () => {
                throw new Error("daemon already dead");
            },
        });
        // Swap still succeeded even though stop() blew up.
        const manifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(manifest.version, "0.2.0");
    });
});

test("upgradeApplyCommand clears marker and throws when staging dir is missing", async () => {
    await withTmp(async (home) => {
        const live = join(home, "live");
        // staging dir does not exist at all
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        await writeLiveShape(live);
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        await rejects(upgradeApplyCommand({ tacoHome: home }), /staging dir missing/);

        // Marker must be cleared so this dead path is not re-attempted.
        ok(!(await readUpgradeMarker(join(home, "upgrade-marker.json"))));

        // Live must still hold the old contents (no swap).
        const manifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(manifest.version, "0.1.0");
    });
});

test("upgradeApplyCommand keeps marker when staging present but malformed", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await mkdir(staging, { recursive: true });
        // No bundle shape; staging exists but is empty.
        await writeLiveShape(live);
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        });

        await rejects(upgradeApplyCommand({ tacoHome: home }), /missing manifest\.json/);

        // The malformed-staging case is recoverable (re-run `taco upgrade`),
        // so the marker must NOT be cleared.
        ok(await readUpgradeMarker(join(home, "upgrade-marker.json")));
    });
});

test("upgradeApplyCommand rolls back to .prev when staging->live rename fails", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        const marker: UpgradeMarker = {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        };
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), marker);

        // Snapshot the live contents before swap so we can verify rollback.
        const beforeManifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(beforeManifest.version, "0.1.0");

        await rejects(
            upgradeApplyCommand({
                tacoHome: home,
                // Fail ONLY the staging->live rename; let the live->prev
                // pass through and the rollback (prev->live) pass through.
                // Failing all three would make the rollback itself fail and
                // leave the system in a worse state than we want to test.
                rename: async (src, dest) => {
                    if (src === staging) {
                        throw Object.assign(new Error("ENOSPC: no space left on device"), {
                            code: "ENOSPC",
                        });
                    }
                    return await import("node:fs/promises").then((m) => m.rename(src, dest));
                },
            }),
            /ENOSPC/,
        );

        // After rollback, live must have the pre-swap contents back.
        const restoredManifest = JSON.parse(
            await readFile(join(live, "manifest.json"), "utf8"),
        ) as { version: string };
        strictEqual(
            restoredManifest.version,
            "0.1.0",
            "live_dir must be restored to pre-swap contents",
        );
        // .prev must NOT exist (rollback moved it back into live).
        await rejects(readFile(`${live}.prev/manifest.json`, "utf8"), /ENOENT/);
        // Marker is NOT cleared on failure (operator can retry after fix).
        const markerAfter = await readUpgradeMarker(join(home, "upgrade-marker.json"));
        ok(markerAfter);
        strictEqual(markerAfter?.version, "0.2.0");
    });
});

test("upgradeApplyCommand falls back to copyFile + unlink on EXDEV (cross-device rename)", async () => {
    await withTmp(async (home) => {
        const staging = join(home, "staging", "sidecar-darwin-arm64-0.2.0");
        const live = join(home, "live");
        await writeBundleShape(staging, "0.2.0");
        await writeLiveShape(live);
        const marker: UpgradeMarker = {
            version: "0.2.0",
            staging_dir: staging,
            live_dir: live,
            written_at: "2026-01-01T00:00:00.000Z",
        };
        await writeUpgradeMarker(join(home, "upgrade-marker.json"), marker);

        const result = await upgradeApplyCommand({
            tacoHome: home,
            // Fail ONLY the staging->live rename with EXDEV; let live->prev
            // pass through so the prevDir rollback target exists. The
            // successful EXDEV path doesn't use rename again afterwards
            // (no rollback needed).
            rename: async (src, dest) => {
                if (src === staging) {
                    throw Object.assign(new Error("EXDEV: cross-device link"), {
                        code: "EXDEV",
                    });
                }
                return await import("node:fs/promises").then((m) => m.rename(src, dest));
            },
        });

        strictEqual(result.version, "0.2.0");
        // Live must contain the new bundle contents (copied, not renamed).
        const newManifest = JSON.parse(await readFile(join(live, "manifest.json"), "utf8")) as {
            version: string;
        };
        strictEqual(newManifest.version, "0.2.0");
        const newBundle = await readFile(join(live, "lib", "index.mjs"), "utf8");
        strictEqual(newBundle.trim(), "// new bundle");
        // Marker cleared (success).
        ok(!(await readUpgradeMarker(join(home, "upgrade-marker.json"))));
        // Staging dir must be gone (the fallback's rm cleaned it).
        await rejects(
            import("node:fs/promises").then((m) => m.stat(staging)),
            /ENOENT/,
        );
    });
});
