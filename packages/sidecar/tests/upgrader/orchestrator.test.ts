/**
 * UpgradeOrchestrator tests. Verifies the boot + periodic recheck
 * contract against an in-memory fake: marker present + staging dir
 * real → ask host to shut down; missing marker / missing staging /
 * malformed marker → no shutdown. Drives `tick()` directly so the
 * suite doesn't have to wait for the real 6h interval.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeUpgradeMarker } from "../../src/upgrader/marker.ts";
import { UpgradeOrchestrator } from "../../src/upgrader/orchestrator.ts";
import type { UpgradeMarker } from "../../src/upgrader/types.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "taco-orchestrator-test-"));
    try {
        return await fn(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function sampleMarker(version: string, stagingDir: string): UpgradeMarker {
    return {
        version,
        staging_dir: stagingDir,
        live_dir: "/tmp/live/sidecar",
        written_at: "2026-01-01T00:00:00.000Z",
    };
}

test("marker + staging present → requestShutdown fires with upgrade-pending", async () => {
    await withTmp(async (root) => {
        const stagingDir = join(root, "staging", "sidecar-0.2.0");
        await mkdir(stagingDir, { recursive: true });
        const markerPath = join(root, "marker.json");
        await writeUpgradeMarker(markerPath, sampleMarker("0.2.0", stagingDir));

        const shutdowns: string[] = [];
        const orch = new UpgradeOrchestrator({
            markerPath,
            requestShutdown: (reason) => {
                shutdowns.push(reason);
            },
            intervalMs: 1_000_000,
        });

        await orch.tick();
        deepStrictEqual(shutdowns, ["upgrade-pending"]);
        orch.stop();
    });
});

test("no marker → no shutdown", async () => {
    await withTmp(async (root) => {
        const orch = new UpgradeOrchestrator({
            markerPath: join(root, "missing.json"),
            requestShutdown: (reason) => {
                throw new Error(`unexpected shutdown: ${reason}`);
            },
        });
        await orch.tick();
        orch.stop();
    });
});

test("malformed marker → no shutdown (tolerant read)", async () => {
    await withTmp(async (root) => {
        const markerPath = join(root, "marker.json");
        await writeFile(markerPath, "{not-json", "utf8");
        const orch = new UpgradeOrchestrator({
            markerPath,
            requestShutdown: () => {
                throw new Error("unexpected shutdown on malformed marker");
            },
        });
        await orch.tick();
        orch.stop();
    });
});

test("marker present but staging dir missing → no shutdown + warn", async () => {
    await withTmp(async (root) => {
        const markerPath = join(root, "marker.json");
        const missingStaging = join(root, "staging", "never-created");
        await writeUpgradeMarker(markerPath, sampleMarker("0.2.0", missingStaging));

        let calls = 0;
        const orch = new UpgradeOrchestrator({
            markerPath,
            requestShutdown: () => {
                calls += 1;
            },
        });
        await orch.tick();
        strictEqual(calls, 0);
        orch.stop();
    });
});

test("start() is idempotent — second call does not double-schedule", async () => {
    await withTmp(async (root) => {
        let calls = 0;
        const orch = new UpgradeOrchestrator({
            markerPath: join(root, "missing.json"),
            requestShutdown: () => {
                calls += 1;
            },
            intervalMs: 1_000_000,
        });
        orch.start();
        orch.start();
        orch.stop();
        strictEqual(calls, 0);
    });
});

test("tick() after shutdown signal does not fire requestShutdown again", async () => {
    await withTmp(async (root) => {
        const stagingDir = join(root, "staging", "sidecar-0.2.0");
        await mkdir(stagingDir, { recursive: true });
        const markerPath = join(root, "marker.json");
        await writeUpgradeMarker(markerPath, sampleMarker("0.2.0", stagingDir));

        let calls = 0;
        const orch = new UpgradeOrchestrator({
            markerPath,
            requestShutdown: () => {
                calls += 1;
            },
        });
        await orch.tick();
        await orch.tick();
        await orch.tick();
        strictEqual(calls, 1);
        orch.stop();
    });
});

test("stop() cancels pending recheck (timer does not fire)", async () => {
    await withTmp(async (root) => {
        let calls = 0;
        const orch = new UpgradeOrchestrator({
            markerPath: join(root, "missing.json"),
            requestShutdown: () => {
                calls += 1;
            },
            intervalMs: 10,
        });
        orch.start();
        orch.stop();
        await new Promise((resolve) => setTimeout(resolve, 50));
        strictEqual(calls, 0);
    });
});

test("start() surfaces orchestrator errors without crashing the caller", async () => {
    let calls = 0;
    const orch = new UpgradeOrchestrator({
        markerPath: "/dev/null/cannot-have-subdir",
        requestShutdown: () => {
            calls += 1;
        },
        intervalMs: 1_000_000,
    });
    orch.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    orch.stop();
    ok(true);
    strictEqual(calls, 0);
});
