#!/usr/bin/env node
/**
 * Dev-boot timing baseline for the sidecar daemon.
 *
 * Spawns a tsx (dev-mode) daemon in an isolated $TACO_HOME and records when
 * it becomes (a) control-connectable, (b) ndjson-connectable, (c) hello-
 * emitting. Probe/timeout tuning (workspace_ensure hello wait, control ping
 * retries, probeDaemonHello) needs real distributions, not guesses — release
 * boots are ~40ms (see daemon.err.log "started" → "listening"), so this
 * fixture exists to capture the dev-mode tsx-compile cost that dominates
 * `pnpm tauri:dev` cold starts.
 *
 * Empty taco.json => no channels start; the measured floor is tsx compile +
 * resolveDeps + socket bind. Real boots with wechat add on top of that.
 *
 * Usage: node packages/sidecar/scripts/bootTiming.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLL_MS = 20;
const TIMEOUT_MS = 90_000;

function findRepoRoot() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
        dir = dirname(dir);
    }
    throw new Error("repo root not found");
}

function tryConnect(path) {
    return new Promise((resolve) => {
        const sock = connect(path);
        sock.once("connect", () => {
            sock.destroy();
            resolve(true);
        });
        sock.once("error", () => resolve(false));
    });
}

function waitForInitialize(path, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
        const sock = connect(path);
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error("initialize timeout"));
        }, timeoutMs);
        let buf = "";
        sock.on("connect", () => {
            const req = {
                id: "boot-timing-probe",
                commandId: "boot-timing-probe",
                method: "initialize",
                params: { protocolVersion: { major: 2, minor: 0 }, clientCapabilities: {} },
            };
            sock.write(`${JSON.stringify(req)}\n`);
        });
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            try {
                const frame = JSON.parse(buf.slice(0, nl));
                if (frame.id === "boot-timing-probe" && typeof frame.ok === "boolean") {
                    clearTimeout(timer);
                    sock.destroy();
                    resolve();
                }
            } catch {
                clearTimeout(timer);
                sock.destroy();
                reject(new Error("non-JSON first frame"));
            }
        });
        sock.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

const ms = (t0) => `${Number(t0) / 1e6}ms`;

async function main() {
    const repoRoot = findRepoRoot();
    // /tmp keeps the socket path under macOS's 104-byte sun_path limit.
    const tmpHome = mkdtempSync("/tmp/taco-boot-");
    const runtimeDir = join(tmpHome, "run");
    mkdirSync(runtimeDir, { recursive: true });
    const ndjson = join(runtimeDir, "sidecar.sock");
    const control = join(runtimeDir, "sidecar-ctl.sock");

    const env = {
        ...process.env,
        TACO_HOME: tmpHome,
        TACO_DAEMON_MODE: "1",
        TACO_SOCKET: ndjson,
        TACO_CONTROL_SOCKET: control,
        TACO_STDERR_LOG: join(tmpHome, "daemon.err.log"),
    };

    const t0 = process.hrtime.bigint();
    const child = spawn(
        join(repoRoot, "node_modules", ".bin", "tsx"),
        [join(repoRoot, "packages", "sidecar", "src", "index.ts")],
        { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let tFirstLog;
    child.stderr.on("data", () => {
        if (tFirstLog === undefined) tFirstLog = process.hrtime.bigint();
    });

    let tControl;
    let tNdjson;
    let tInitialize;
    try {
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline && tInitialize === undefined) {
            if (tControl === undefined && (await tryConnect(control))) {
                tControl = process.hrtime.bigint();
            }
            if (tNdjson === undefined && (await tryConnect(ndjson))) {
                tNdjson = process.hrtime.bigint();
            }
            if (tNdjson !== undefined && tInitialize === undefined) {
                try {
                    await waitForInitialize(ndjson);
                    tInitialize = process.hrtime.bigint();
                } catch {
                    // Daemon may have re-created the socket between our probe
                    // connect and the initialize connect; retry on next tick.
                }
            }
            await new Promise((r) => setTimeout(r, POLL_MS));
        }

        console.log("sidecar dev-boot timing (isolated TACO_HOME, no channels):");
        console.log(`  spawn -> first stderr output : ${tFirstLog ? ms(tFirstLog - t0) : "n/a"}`);
        console.log(`  spawn -> control connectable : ${tControl ? ms(tControl - t0) : "TIMEOUT"}`);
        console.log(`  spawn -> ndjson connectable  : ${tNdjson ? ms(tNdjson - t0) : "TIMEOUT"}`);
        console.log(
            `  spawn -> initialize answered  : ${tInitialize ? ms(tInitialize - t0) : "TIMEOUT"}`,
        );
        if (tControl && tNdjson) {
            console.log(
                `  control bind -> ndjson bind   : ${ms(tNdjson - tControl)} (init window)`,
            );
        }
        if (tNdjson && tInitialize) {
            console.log(`  ndjson bind -> initialize     : ${ms(tInitialize - tNdjson)}`);
        }
        process.exitCode = tInitialize !== undefined ? 0 : 1;
    } finally {
        child.kill("SIGTERM");
        await new Promise((r) => {
            child.once("exit", r);
            setTimeout(r, 3_000);
        });
        rmSync(tmpHome, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
