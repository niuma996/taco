/**
 * `taco start` against a live daemon owned by another install.
 *
 * Regression: a launchd service registered by `taco install` from one install
 * kept running old code while a dev checkout restarted around it. The dev
 * launcher saw a "stale" daemon, refused to kill it (foreign install_id) but
 * still unlinked its socket paths and spawned a second daemon — clients that
 * had already connected stayed on the old build indefinitely.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ForeignDaemonError, startCommand } from "../lib/start.ts";

const scratch = mkdtempSync(join(tmpdir(), "taco-start-foreign-"));
const tacoHome = join(scratch, "home");
const runtimeDir = join(scratch, "run");
let server: Server;

before(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tacoHome, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    // A serving daemon: answers the launcher's initialize probe.
    server = createServer((sock) => {
        sock.on("data", (chunk) => {
            const req = JSON.parse(chunk.toString("utf8").trim()) as { id: string };
            sock.write(`${JSON.stringify({ id: req.id, ok: true, result: {} })}\n`);
        });
    });
    await new Promise<void>((resolve) => server.listen(join(runtimeDir, "sidecar.sock"), resolve));
    // Owned by someone else, and alive: this test process stands in for it.
    writeFileSync(
        join(runtimeDir, "sidecar.pid"),
        JSON.stringify({
            version: 1,
            pid: process.pid,
            install_id: "0000000000000000",
            started_at: new Date().toISOString(),
            sidecar_version: "0.0.1",
        }),
    );
});

after(async () => {
    // If the guard regresses, `taco start` really spawns a detached daemon
    // into this scratch dir and rewrites the pid file with its pid. It
    // outlives the test (and the deleted dir), so reap it before cleanup.
    // SIGKILL: its TACO_HOME is about to vanish, so a graceful exit may hang.
    try {
        const { pid } = JSON.parse(readFileSync(join(runtimeDir, "sidecar.pid"), "utf8")) as {
            pid: number;
        };
        if (pid !== process.pid) process.kill(pid, "SIGKILL");
    } catch {
        /* no pid file, or the process is already gone */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
});

test("refuses to restart around a live foreign daemon and leaves its socket alone", async () => {
    await assert.rejects(startCommand({ tacoHome, runtimeDir }), ForeignDaemonError);
    assert.ok(
        existsSync(join(runtimeDir, "sidecar.sock")),
        "the other install's socket must not be unlinked",
    );
    assert.ok(existsSync(join(runtimeDir, "sidecar.pid")), "its pid file must survive");
});
