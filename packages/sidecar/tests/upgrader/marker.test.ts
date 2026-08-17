/**
 * Upgrade-marker round-trip tests. The on-disk shape is the only
 * contract between the CLI writer + the daemon reader, so we exercise
 * it directly: write a marker, read it back, clear it.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    clearUpgradeMarker,
    readUpgradeMarker,
    writeUpgradeMarker,
} from "../../src/upgrader/marker.ts";
import type { UpgradeMarker } from "../../src/upgrader/types.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-marker-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function sampleMarker(): UpgradeMarker {
    return {
        version: "0.2.0",
        staging_dir: "/tmp/staging/sidecar-0.2.0",
        live_dir: "/tmp/live/sidecar",
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

test("readUpgradeMarker returns null for a missing file (no throw)", async () => {
    await withTmp(async (dir) => {
        strictEqual(await readUpgradeMarker(join(dir, "missing.json")), null);
    });
});

test("readUpgradeMarker returns null + warns on malformed JSON", async () => {
    await withTmp(async (dir) => {
        const path = join(dir, "marker.json");
        await mkdir(dir, { recursive: true });
        await writeMalformed(path, "{not-json");
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
        // Sanity-check the file content too — the on-disk JSON shape is
        // what the CLI writer produces; if it changes here, drift with
        // the CLI surfaces immediately.
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as UpgradeMarker;
        strictEqual(parsed.version, "0.2.0");
        // No .tmp leftover — stat() the path directly and expect ENOENT
        // (catching the error would swallow it and hide a regression).
        const tmpPath = `${path}.tmp`;
        await rejects(stat(tmpPath), /ENOENT/);
    });
});

async function writeMalformed(path: string, contents: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, contents, "utf8");
}
