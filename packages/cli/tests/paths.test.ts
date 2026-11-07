/**
 * Pure-helper tests for the CLI's path + install-id + launcher resolution.
 *
 * Consolidated into one file so `tsx --test` pays the module-resolution
 * cost once instead of three times. All three cover leaf modules with no
 * side effects, so they share a process safely.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { computeInstallId, parsePidFile, pidRecordIsStale } from "../lib/installId.ts";
import {
    controlSocketPath,
    defaultRuntimeDir,
    ndjsonSocketPath,
    resolveTacoRuntimeDir,
    runtimePidFile,
    windowsPipeSlug,
} from "../lib/paths.ts";
import { locateTsxLoader, resolveDevLaunch } from "../lib/sidecarLauncher.ts";

// ─── paths ──────────────────────────────────────────────────────────────────

test("explicit runtime directory owns all daemon coordination paths", () => {
    const runtime = resolveTacoRuntimeDir("/Users/test/.taco", "/Users/test/.taco-dev/run");
    strictEqual(runtime, "/Users/test/.taco-dev/run");
    if (process.platform === "win32") {
        const slug = windowsPipeSlug(runtime);
        strictEqual(ndjsonSocketPath(runtime), `\\\\.\\pipe\\taco-sidecar-${slug}`);
        strictEqual(controlSocketPath(runtime), `\\\\.\\pipe\\taco-sidecar-ctl-${slug}`);
    } else {
        strictEqual(ndjsonSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar.sock");
        strictEqual(controlSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar-ctl.sock");
    }
    strictEqual(runtimePidFile(runtime), join(runtime, "sidecar.pid"));
});

test("blank runtime override defaults to the shared home run directory", () => {
    strictEqual(defaultRuntimeDir("/profiles/team-a"), join("/profiles/team-a", "run"));
    strictEqual(resolveTacoRuntimeDir("/profiles/team-a", "  "), join("/profiles/team-a", "run"));
});

test("windowsPipeSlug is stable across slash, case, trailing-sep, and verbatim prefixes", () => {
    const canonical = "C:\\Users\\test\\.taco-dev\\run";
    strictEqual(windowsPipeSlug(canonical), "3046aa052e73dbd5");
    strictEqual(windowsPipeSlug("c:/Users/test/.taco-dev/run"), "3046aa052e73dbd5");
    strictEqual(windowsPipeSlug("\\\\?\\C:\\Users\\test\\.taco-dev\\run"), "3046aa052e73dbd5");
    strictEqual(windowsPipeSlug("//?/C:/Users/test/.taco-dev/run"), "3046aa052e73dbd5");
    strictEqual(windowsPipeSlug("C:\\Users\\test\\.taco-dev\\run\\"), "3046aa052e73dbd5");
    ok(windowsPipeSlug("C:\\Users\\test\\.taco\\run") !== windowsPipeSlug(canonical));
});

test("windowsPipeSlug folds ASCII only, matching the Rust twin's make_ascii_lowercase", () => {
    strictEqual(
        windowsPipeSlug("C:\\Users\\ÜNDREA\\.taco-dev\\run"),
        windowsPipeSlug("c:\\users\\ÜNDREA\\.taco-dev\\run"),
    );
    ok(
        windowsPipeSlug("C:\\Users\\ÜNDREA\\.taco-dev\\run") !==
            windowsPipeSlug("C:\\Users\\ündrea\\.taco-dev\\run"),
    );
});

// ─── installId ──────────────────────────────────────────────────────────────

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

// ─── sidecarLauncher ────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "taco-sidecar-launcher-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("resolveDevLaunch spawns node --import tsx/dist/loader.mjs, never the CLI or .bin shim", () => {
    const tsxDir = join(scratch, "node_modules", "tsx", "dist");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(join(tsxDir, "loader.mjs"), "export {};\n");
    mkdirSync(join(scratch, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", ".bin", "tsx.cmd"), "@echo off\n");
    writeFileSync(join(tsxDir, "cli.mjs"), "export {};\n");

    const launch = resolveDevLaunch(scratch);
    strictEqual(launch.program, process.execPath);
    strictEqual(launch.args[0], "--import");
    strictEqual(launch.args[1], pathToFileURL(join(tsxDir, "loader.mjs")).href);
    strictEqual(launch.args[2], join(scratch, "packages", "sidecar", "src", "index.ts"));
    strictEqual(launch.cwd, scratch);
    ok(!launch.args.some((a) => a.endsWith(".cmd")), "must not spawn the Windows .cmd shim");
    ok(
        !launch.args.some((a) => a.includes("cli.mjs")),
        "must not spawn tsx/dist/cli.mjs (it re-forks node without windowsHide)",
    );
});

test("locateTsxLoader prefers the checkout-local tsx over a nested walk", () => {
    const tsxDir = join(scratch, "node_modules", "tsx", "dist");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(join(tsxDir, "loader.mjs"), "export {};\n");
    strictEqual(locateTsxLoader(scratch), join(tsxDir, "loader.mjs"));
});
