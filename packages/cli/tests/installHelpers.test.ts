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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleHasDaemonMode, probePkgDir } from "../lib/installHelpers.ts";

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

/**
 * probePkgDir holds the validation shared by all three resolution strategies in
 * `findPlatformPkg`. It is what makes the dev-checkout fallback safe: the
 * `dist/runtime/<triple>/` tree is accepted only when it carries the same
 * artifacts a released platform package would, so a half-built dist cannot
 * produce a launchd wrapper pointing at a missing binary.
 */

/** Build a directory shaped like a sidecar runtime. Omit pieces via `skip` to
 *  exercise each rejection path. */
async function stageRuntime(
    dir: string,
    opts: {
        target?: string;
        daemonMode?: boolean;
        manifest?: string;
        skip?: ("manifest" | "nodeBin" | "bundle")[];
        bundleBody?: string;
    } = {},
): Promise<void> {
    const skip = opts.skip ?? [];
    if (!skip.includes("manifest")) {
        const body =
            opts.manifest ??
            JSON.stringify({
                target: opts.target ?? "aarch64-apple-darwin",
                ...(opts.daemonMode === undefined ? {} : { daemonMode: opts.daemonMode }),
            });
        await writeFile(join(dir, "manifest.json"), body);
    }
    if (!skip.includes("nodeBin")) {
        await mkdir(join(dir, "bin"), { recursive: true });
        const name = opts.target?.endsWith("-pc-windows-msvc")
            ? "taco-sidecar-node.exe"
            : "taco-sidecar-node";
        await writeFile(join(dir, "bin", name), "#!/bin/sh\n");
    }
    if (!skip.includes("bundle")) {
        await mkdir(join(dir, "lib"), { recursive: true });
        await writeFile(
            join(dir, "lib", "index.mjs"),
            opts.bundleBody ?? "if (process.env.TACO_DAEMON_MODE) {}\n",
        );
    }
}

test("probePkgDir accepts a complete runtime tree", async () => {
    await withTmp(async (dir) => {
        await stageRuntime(dir, { daemonMode: true });
        const found = probePkgDir(dir);
        ok(found);
        strictEqual(found.pkgDir, dir);
        strictEqual(found.nodeBin, join(dir, "bin", "taco-sidecar-node"));
        strictEqual(found.bundle, join(dir, "lib", "index.mjs"));
        // resources doubles as TACO_SIDECAR_RESOURCES (agents/ + skills/ root).
        strictEqual(found.resources, dir);
        strictEqual(found.daemonMode, true);
    });
});

test("probePkgDir picks the .exe node binary for a windows target", async () => {
    await withTmp(async (dir) => {
        await stageRuntime(dir, { target: "x86_64-pc-windows-msvc", daemonMode: true });
        const found = probePkgDir(dir);
        ok(found);
        strictEqual(found.nodeBin, join(dir, "bin", "taco-sidecar-node.exe"));
    });
});

test("probePkgDir falls back to a bundle grep when the manifest omits daemonMode", async () => {
    await withTmp(async (dir) => {
        // Pre-daemonMode manifests exist in the wild; the flag's absence must
        // not be read as "no daemon support" when the bundle in fact has it.
        await stageRuntime(dir);
        strictEqual(probePkgDir(dir)?.daemonMode, true);
    });
});

test("probePkgDir reports daemonMode false for a stale bundle", async () => {
    await withTmp(async (dir) => {
        await stageRuntime(dir, { bundleBody: "runStdio();\n" });
        // Resolution still succeeds — `taco install` wants to fail with a
        // rebuild instruction, which needs the paths, not a null.
        strictEqual(probePkgDir(dir)?.daemonMode, false);
    });
});

test("probePkgDir rejects a tree missing any required artifact", async () => {
    for (const missing of ["manifest", "nodeBin", "bundle"] as const) {
        await withTmp(async (dir) => {
            await stageRuntime(dir, { skip: [missing], daemonMode: true });
            strictEqual(probePkgDir(dir), null, `expected null when ${missing} is absent`);
        });
    }
});

test("probePkgDir rejects a malformed manifest instead of throwing", async () => {
    await withTmp(async (dir) => {
        // A truncated write (interrupted build) must fall through to the next
        // strategy rather than crash `taco install`.
        await stageRuntime(dir, { manifest: '{"target": "aarch64-appl' });
        strictEqual(probePkgDir(dir), null);
    });
});

test("probePkgDir returns null for a directory that does not exist", async () => {
    await withTmp(async (dir) => {
        strictEqual(probePkgDir(join(dir, "nope")), null);
    });
});
