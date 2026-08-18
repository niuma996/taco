/**
 * Tests for the install-time bundle sanity check. The regression that
 * produced this: `taco install` happily registered a launchd wrapper that
 * pointed at a bundle built BEFORE daemon mode existed. launchd spawned
 * it, the process booted into stdio mode (because the bundle never read
 * `TACO_DAEMON_MODE`), stdin was EOF so it exited 0 — and the desktop's
 * 5s hello wait timed out with no actionable breadcrumb. The check below
 * fails fast with a clear rebuild instruction instead.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleHasDaemonMode } from "../lib/installHelpers.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-install-helpers-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("bundleHasDaemonMode returns true when the bundle contains the env-var gate", async () => {
    await withTmp(async (dir) => {
        const bundle = join(dir, "index.mjs");
        await writeFile(
            bundle,
            "// bundle\nif (process.env.TACO_DAEMON_MODE === '1') { /* daemon */ }\n",
        );
        strictEqual(bundleHasDaemonMode(bundle), true);
    });
});

test("bundleHasDaemonMode returns false for a pre-daemon bundle", async () => {
    await withTmp(async (dir) => {
        const bundle = join(dir, "index.mjs");
        // Mimics the stale bundle that triggered the regression — no
        // TACO_DAEMON_MODE string anywhere, so the runtime gates never
        // see it and the process always boots into stdio mode.
        await writeFile(bundle, "// stdio-only sidecar\nrunStdio();\n");
        strictEqual(bundleHasDaemonMode(bundle), false);
    });
});

test("bundleHasDaemonMode returns false when the file does not exist", async () => {
    await withTmp(async (dir) => {
        // install-time error handling: findPlatformPkg already filters out
        // missing files, but if we ever call this directly the helper must
        // not throw — "can't read" is indistinguishable from "no daemon
        // support" for our purposes, and the caller fails with the same
        // rebuild-either-way message.
        strictEqual(bundleHasDaemonMode(join(dir, "missing.mjs")), false);
    });
});

test("bundleHasDaemonMode matches a substring anywhere in the bundle", async () => {
    await withTmp(async (dir) => {
        const bundle = join(dir, "index.mjs");
        // The string can show up anywhere — env-var read, string literal,
        // even a comment. We grep rather than AST-parse because the
        // bundle is minified; substring presence is the strongest signal
        // we can cheaply extract.
        await writeFile(
            bundle,
            "// preamble\nconst x = 1;\n// mode detection: TACO_DAEMON_MODE gates the daemon entry\n",
        );
        ok(bundleHasDaemonMode(bundle));
    });
});
