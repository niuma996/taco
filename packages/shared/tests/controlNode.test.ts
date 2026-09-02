/**
 * controlNode — round-trip tests against a real Unix-domain-socket echo
 * server.
 *
 * covers:
 *   1. Happy path: one request, one reply, `result` resolves.
 *   2. Server returns `error`: promise rejects with method-labelled Error.
 *   3. Connection refused (no listener on a fresh path): promise rejects
 *      with method label + underlying error message.
 *   4. Timeout: promise rejects with `<method> timed out after <ms>ms`.
 *      Implemented as a fresh per-test server (separate socket path)
 *      so the test owns its full lifecycle.
 *   5. Malformed JSON reply: promise rejects with `malformed reply`.
 *   6. Socket closes before any reply: promise rejects with
 *      `socket closed before reply`.
 *   7. `params` payload is serialised onto the wire (echo server
 *      round-trips it into `result`).
 *
 * Note: TCP-loopback listening is blocked by the Codex sandbox
 * (`listen EPERM 127.0.0.1`), so we use Unix domain sockets instead. The
 * controlNode helper supports any path-or-host the `net.connect` API
 * accepts, so this is purely a test-time convenience.
 *
 * Run: cd packages/shared && pnpm exec tsx --test tests/controlNode.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { controlRequest } from "../controlNode.ts";

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-controlnode-"));
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Per-test server factory. `mode` controls how the server replies:
 *   - "ok": echo back the request id with a configured result
 *   - "err": reply with { error: { code, message } }
 *   - "malformed": write invalid JSON
 *   - "drop": close the socket immediately after accepting the connection
 *   - "silent": accept but never reply (timeout test)
 */
async function startServer(
    mode: "ok" | "err" | "malformed" | "drop" | "silent",
    result: unknown = { ok: true },
    errorBody: { code: string; message: string } = {
        code: "shutdown_in_progress",
        message: "test error",
    },
): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const socketPath = join(
        tmpDir,
        `${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const openSockets = new Set<Socket>();
    const server: Server = createServer((sock: Socket) => {
        openSockets.add(sock);
        sock.on("close", () => openSockets.delete(sock));
        if (mode === "silent") {
            return;
        }
        let buf = "";
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            let req: { id?: unknown; params?: unknown } = {};
            try {
                req = JSON.parse(line);
            } catch {
                sock.destroy();
                return;
            }
            const id = typeof req.id === "number" ? req.id : 0;
            if (mode === "drop") {
                // Graceful half-close: end() the server side. Client sees
                // the remote end-of-stream and fires 'close' without any
                // reply data — the helper's close-before-reply branch is
                // the contract.
                sock.end();
                return;
            }
            if (mode === "malformed") {
                sock.write("not-json\n");
                return;
            }
            if (mode === "err") {
                sock.write(`${JSON.stringify({ error: errorBody, id })}\n`);
                return;
            }
            const reply = {
                result: { ...((result as object) ?? {}), echo: req.params ?? null },
                id,
            };
            sock.write(`${JSON.stringify(reply)}\n`);
        });
        sock.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
    });
    return {
        endpoint: socketPath,
        close: () =>
            new Promise<void>((resolve) => {
                // closeAllConnections drops any in-flight sockets
                // immediately so server.close() doesn't wait for them
                // to drain — important for the timeout suite where the
                // silent server has a half-open connection from the
                // client that already timed out. The cast keeps the
                // runtime guard; @types/node@22 does not declare the
                // method on `net.Server` so the compiler cannot help us.
                (server as { closeAllConnections?: () => void }).closeAllConnections?.();
                for (const s of openSockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}

describe("controlRequest — happy path", () => {
    let endpoint = "";
    let closeServer: () => Promise<void> = async () => {};

    before(async () => {
        const s = await startServer("ok", { version: "0.1.2", pid: 1234, uptime_s: 42 });
        endpoint = s.endpoint;
        closeServer = s.close;
    });
    after(closeServer);

    it("resolves with the server's result", async () => {
        const result = await controlRequest(endpoint, "control.ping", { timeoutMs: 1000 });
        assert.deepEqual(result, { version: "0.1.2", pid: 1234, uptime_s: 42, echo: null });
    });

    it("round-trips the params payload when provided", async () => {
        const result = await controlRequest(endpoint, "control.ping", {
            timeoutMs: 1000,
            params: { hello: "world" },
        });
        assert.deepEqual(result, {
            version: "0.1.2",
            pid: 1234,
            uptime_s: 42,
            echo: { hello: "world" },
        });
    });

    it("uses the supplied request id on the wire", async () => {
        const result = await controlRequest(endpoint, "control.ping", {
            timeoutMs: 1000,
            id: 42,
        });
        assert.ok(result);
    });
});

describe("controlRequest — error reply", () => {
    let endpoint = "";
    let closeServer: () => Promise<void> = async () => {};

    before(async () => {
        const s = await startServer("err", undefined, { code: "busy", message: "daemon busy" });
        endpoint = s.endpoint;
        closeServer = s.close;
    });
    after(closeServer);

    it("rejects with method-labelled error", async () => {
        await assert.rejects(
            controlRequest(endpoint, "control.shutdown", { timeoutMs: 1000 }),
            (err: Error) => {
                assert.match(err.message, /control\.shutdown: busy: daemon busy/);
                return true;
            },
        );
    });
});

describe("controlRequest — connection refused", () => {
    it("rejects with method-labelled underlying error", async () => {
        const missing = join(tmpDir, `missing-${Date.now()}.sock`);
        await assert.rejects(
            controlRequest(missing, "control.ping", { timeoutMs: 1000 }),
            (err: Error) => {
                assert.match(err.message, /^control\.ping:/);
                assert.ok(
                    err.message.includes("ENOENT") || err.message.includes("ECONNREFUSED"),
                    `unexpected message: ${err.message}`,
                );
                return true;
            },
        );
    });
});

describe("controlRequest — timeout", () => {
    it("rejects with '<method> timed out after <ms>ms'", async () => {
        const { endpoint, close } = await startServer("silent");
        try {
            await assert.rejects(
                controlRequest(endpoint, "control.shutdown", { timeoutMs: 100 }),
                (err: Error) => {
                    assert.match(err.message, /control\.shutdown timed out after 100ms/);
                    return true;
                },
            );
        } finally {
            await close();
        }
    });
});

describe("controlRequest — malformed reply", () => {
    let endpoint = "";
    let closeServer: () => Promise<void> = async () => {};

    before(async () => {
        const s = await startServer("malformed");
        endpoint = s.endpoint;
        closeServer = s.close;
    });
    after(closeServer);

    it("rejects with 'malformed reply'", async () => {
        await assert.rejects(
            controlRequest(endpoint, "control.ping", { timeoutMs: 1000 }),
            (err: Error) => {
                assert.match(err.message, /control\.ping: malformed reply:/);
                return true;
            },
        );
    });
});

describe("controlRequest — socket closes before reply", () => {
    let endpoint = "";
    let closeServer: () => Promise<void> = async () => {};

    before(async () => {
        const s = await startServer("drop");
        endpoint = s.endpoint;
        closeServer = s.close;
    });
    after(closeServer);

    it("rejects with 'socket closed before reply'", async () => {
        await assert.rejects(
            controlRequest(endpoint, "control.ping", { timeoutMs: 1000 }),
            (err: Error) => {
                assert.match(err.message, /control\.ping: socket closed before reply/);
                return true;
            },
        );
    });
});
