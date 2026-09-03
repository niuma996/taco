import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { computeInstallId, parsePidFile, pidRecordIsStale } from "../lib/installId.ts";

test("computeInstallId is deterministic and bounded to 16 hex chars", () => {
    const a = computeInstallId("/usr/local/share/taco/sidecar", "/Users/x/.taco");
    const b = computeInstallId("/usr/local/share/taco/sidecar", "/Users/x/.taco");
    strictEqual(a, b);
    strictEqual(a.length, 16);
    ok(/^[0-9a-f]{16}$/.test(a), "must be lowercase hex");
});

test("computeInstallId differs across install roots", () => {
    const a = computeInstallId("/install-a/sidecar", "/Users/x/.taco");
    const b = computeInstallId("/install-b/sidecar", "/Users/x/.taco");
    ok(a !== b, "different resources roots must produce different ids");
});

test("computeInstallId differs across taco homes", () => {
    const a = computeInstallId("/install/sidecar", "/Users/x/.taco");
    const b = computeInstallId("/install/sidecar", "/Users/y/.taco");
    ok(a !== b, "different taco homes must produce different ids");
});

test("computeInstallId must stay byte-for-byte compatible with the sidecar copy", () => {
    // Hard-coded golden vector. If this ever changes, both the sidecar
    // and the CLI have to be updated in lockstep — failing this test is
    // the loud failure mode for that drift.
    const id = computeInstallId("/repo/packages/sidecar/src", "/home/dev/.taco");
    strictEqual(id, "c8ffd7d5d75fcb04");
});

test("parsePidFile accepts the JSON record format", () => {
    const raw = JSON.stringify({
        version: 1,
        pid: 4242,
        install_id: "abcd1234ef567890",
        started_at: "2026-08-19T10:00:00.000Z",
    });
    const parsed = parsePidFile(raw);
    ok(parsed);
    strictEqual(parsed.pid, 4242);
    strictEqual(parsed.installId, "abcd1234ef567890");
    strictEqual(parsed.startedAt, "2026-08-19T10:00:00.000Z");
    strictEqual(parsed.version, 1);
});

test("parsePidFile accepts the legacy bare-int format", () => {
    const parsed = parsePidFile("4242\n");
    ok(parsed);
    strictEqual(parsed.pid, 4242);
    strictEqual(parsed.installId, null);
    strictEqual(parsed.startedAt, null);
    strictEqual(parsed.version, null);
});

test("parsePidFile returns null on malformed input", () => {
    strictEqual(parsePidFile(""), null);
    strictEqual(parsePidFile("   \n"), null);
    strictEqual(parsePidFile("not a pid"), null);
    strictEqual(parsePidFile("-5"), null);
    strictEqual(parsePidFile("0"), null);
});

test("parsePidFile returns null when JSON has unknown schema version", () => {
    const raw = JSON.stringify({
        version: 2,
        pid: 4242,
        install_id: "abcd1234ef567890",
        started_at: "2026-08-19T10:00:00.000Z",
    });
    strictEqual(parsePidFile(raw), null);
});

test("parsePidFile returns null when JSON has missing/invalid pid", () => {
    const rawMissing = JSON.stringify({
        version: 1,
        install_id: "abcd1234ef567890",
        started_at: "2026-08-19T10:00:00.000Z",
    });
    strictEqual(parsePidFile(rawMissing), null);

    const rawBadPid = JSON.stringify({
        version: 1,
        pid: "not a number",
        install_id: "abcd1234ef567890",
        started_at: "2026-08-19T10:00:00.000Z",
    });
    strictEqual(parsePidFile(rawBadPid), null);
});

test("parsePidFile surfaces sidecar_version, null when absent or legacy", () => {
    const withVersion = parsePidFile(
        JSON.stringify({
            version: 1,
            pid: 4242,
            install_id: "abcd1234ef567890",
            started_at: "2026-08-19T10:00:00.000Z",
            sidecar_version: "0.1.2",
        }),
    );
    ok(withVersion);
    strictEqual(withVersion.sidecarVersion, "0.1.2");

    const preFieldRecord = parsePidFile(
        JSON.stringify({
            version: 1,
            pid: 4242,
            install_id: "abcd1234ef567890",
            started_at: "2026-08-19T10:00:00.000Z",
        }),
    );
    ok(preFieldRecord);
    strictEqual(preFieldRecord.sidecarVersion, null);

    const legacy = parsePidFile("4242\n");
    ok(legacy);
    strictEqual(legacy.sidecarVersion, null);
});

test("pidRecordIsStale: version gate only ever applies to our own daemon", () => {
    const own = computeInstallId("/this/install", "/this/home");
    const record = (
        installId: string | null,
        sidecarVersion: string | null,
    ): ReturnType<typeof parsePidFile> => ({
        pid: 4242,
        installId,
        startedAt: null,
        version: 1,
        sidecarVersion,
    });

    // Ours, same version → reuse.
    strictEqual(pidRecordIsStale(record(own, "0.1.2"), own, "0.1.2"), false);
    // Ours, older version → stale (the upgrade case this gate exists for).
    strictEqual(pidRecordIsStale(record(own, "0.1.0"), own, "0.1.2"), true);
    // Ours, pre-field record (no version) → stale: older than any comparing launcher.
    strictEqual(pidRecordIsStale(record(own, null), own, "0.1.2"), true);
    // Legacy bare-int (null install_id) → owned by migration rule, and stale.
    strictEqual(pidRecordIsStale(record(null, null), own, "0.1.2"), true);
    // Foreign install → never stale FOR US; the sibling install owns its daemon.
    strictEqual(pidRecordIsStale(record("ffff000000000000", "0.0.1"), own, "0.1.2"), false);
    // No parseable record → no ownership claim → no kill.
    strictEqual(pidRecordIsStale(null, own, "0.1.2"), false);
});
