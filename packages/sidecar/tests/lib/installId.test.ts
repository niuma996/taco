import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildSidecarPidRecord, computeInstallId } from "../../src/lib/installId.ts";

test("computeInstallId matches the CLI and Rust golden vector", () => {
    // Same vector as packages/cli/tests/installId.test.ts and
    // clients/taco-desktop/src-tauri/tests/daemon_reap.rs. All three
    // implementations MUST stay byte-for-byte identical — failing here means
    // the desktop reap path would skip a daemon it owns (or kill one it
    // doesn't).
    strictEqual(
        computeInstallId("/repo/packages/sidecar/src", "/home/dev/.taco"),
        "c8ffd7d5d75fcb04",
    );
});

test("buildSidecarPidRecord stamps sidecar_version when provided", () => {
    const record = buildSidecarPidRecord(
        4242,
        "abcd1234ef567890",
        "0.1.2",
        () => new Date("2026-09-03T10:00:00.000Z"),
    );
    strictEqual(record.version, 1);
    strictEqual(record.pid, 4242);
    strictEqual(record.install_id, "abcd1234ef567890");
    strictEqual(record.started_at, "2026-09-03T10:00:00.000Z");
    strictEqual(record.sidecar_version, "0.1.2");
});

test("buildSidecarPidRecord omits sidecar_version when not provided", () => {
    // Launchers treat a missing field as "stale" — it must stay absent
    // (not null / "") so old-record semantics round-trip through JSON.
    const record = buildSidecarPidRecord(4242, "abcd1234ef567890");
    ok(!("sidecar_version" in record));
});
