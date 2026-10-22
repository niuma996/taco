import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
    clearUpgradeMarker,
    readUpgradeMarker,
    writeUpgradeMarker,
} from "../../src/upgrader/marker.ts";
import { UpgradeOrchestrator } from "../../src/upgrader/orchestrator.ts";
import type { UpgradeMarker } from "../../src/upgrader/types.ts";

describe("marker", () => {
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
});

describe("orchestrator", () => {
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

    test("liveDir matches marker.live_dir → shutdown fires (own upgrade)", async () => {
        await withTmp(async (root) => {
            const stagingDir = join(root, "staging", "sidecar-0.2.0");
            await mkdir(stagingDir, { recursive: true });
            const markerPath = join(root, "marker.json");
            await writeUpgradeMarker(markerPath, sampleMarker("0.2.0", stagingDir));

            const shutdowns: string[] = [];
            const orch = new UpgradeOrchestrator({
                markerPath,
                liveDir: "/tmp/live/sidecar",
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

    test("liveDir mismatch → foreign marker ignored: no shutdown, marker kept", async () => {
        await withTmp(async (root) => {
            // Deliberately NO staging dir: a foreign marker with missing staging
            // must still be left untouched — its owner decides whether to clear.
            const markerPath = join(root, "marker.json");
            await writeUpgradeMarker(markerPath, sampleMarker("0.2.0", join(root, "no-staging")));

            let calls = 0;
            const orch = new UpgradeOrchestrator({
                markerPath,
                liveDir: join(root, "bundled-sidecar"),
                requestShutdown: () => {
                    calls += 1;
                },
                intervalMs: 1_000_000,
            });

            await orch.tick();
            strictEqual(calls, 0);
            ok(
                (await readFile(markerPath, "utf8")).length > 0,
                "foreign marker must not be cleared",
            );
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
});
