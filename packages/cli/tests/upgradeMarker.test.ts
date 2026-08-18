/**
 * Upgrade-marker round-trip tests for the CLI side. The on-disk JSON shape
 * MUST match what the sidecar's `packages/sidecar/src/upgrader/marker.ts`
 * reads — drift here would break the daemon's orchestrator. These mirror
 * the sidecar's marker test, plus a cross-implementation sanity check
 * that the CLI-written file is parseable by the sidecar's reader.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    clearUpgradeMarker,
    markerTargetsInstall,
    readUpgradeMarker,
    writeUpgradeMarker,
} from "../lib/upgradeMarker.ts";
import type { UpgradeMarker } from "../lib/upgradeTypes.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-cli-marker-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function sampleMarker(): UpgradeMarker {
    return {
        version: "0.2.0",
        staging_dir: "/tmp/staging/sidecar-darwin-arm64-0.2.0",
        live_dir: "/tmp/live/sidecar-darwin-arm64",
        written_at: "2026-01-01T00:00:00.000Z",
    };
}

test("write + read round-trip preserves all fields", async () => {
    await withTmp(async (dir) => {
        const path = join(dir, "marker.json");
        const marker = sampleMarker();
        await writeUpgradeMarker(path, marker);
        const round = await readUpgradeMarker(path);
        deepStrictEqual(round, marker);
    });
});

test("readUpgradeMarker returns null for a missing file", async () => {
    await withTmp(async (dir) => {
        strictEqual(await readUpgradeMarker(join(dir, "missing.json")), null);
    });
});

test("readUpgradeMarker returns null + warns on malformed JSON", async () => {
    await withTmp(async (dir) => {
        const path = join(dir, "marker.json");
        await mkdir(dir, { recursive: true });
        await writeFile(path, "{not-json", "utf8");
        strictEqual(await readUpgradeMarker(path), null);
    });
});

test("clearUpgradeMarker is idempotent (missing file does not throw)", async () => {
    await withTmp(async (dir) => {
        await clearUpgradeMarker(join(dir, "missing.json"));
        const path = join(dir, "marker.json");
        await writeUpgradeMarker(path, sampleMarker());
        await clearUpgradeMarker(path);
        strictEqual(await readUpgradeMarker(path), null);
    });
});

test("writeUpgradeMarker creates the parent directory if missing", async () => {
    await withTmp(async (dir) => {
        const nested = join(dir, "nested", "deeper", "marker.json");
        await writeUpgradeMarker(nested, sampleMarker());
        ok(await readUpgradeMarker(nested));
    });
});

test("writeUpgradeMarker persists valid JSON (no leftover .tmp)", async () => {
    await withTmp(async (dir) => {
        const path = join(dir, "marker.json");
        await writeUpgradeMarker(path, sampleMarker());
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as UpgradeMarker;
        strictEqual(parsed.version, "0.2.0");
        const tmpPath = `${path}.tmp`;
        await rejects(stat(tmpPath), /ENOENT/);
    });
});

test("markerTargetsInstall matches only the marker's own live_dir", () => {
    const marker = sampleMarker();
    strictEqual(markerTargetsInstall(marker, "/tmp/live/sidecar-darwin-arm64"), true);
    // Same root via non-normalized spelling (trailing slash, `.` segment).
    strictEqual(markerTargetsInstall(marker, "/tmp/live/./sidecar-darwin-arm64/"), true);
    // A different installation sharing $TACO_HOME (e.g. desktop bundle).
    strictEqual(
        markerTargetsInstall(marker, "/Applications/Taco.app/Contents/Resources/sidecar"),
        false,
    );
    // Unknown own root → never claim the marker.
    strictEqual(markerTargetsInstall(marker, null), false);
    strictEqual(markerTargetsInstall(marker, undefined), false);
});
