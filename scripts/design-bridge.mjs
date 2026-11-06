#!/usr/bin/env node
/**
 * design-bridge.mjs — run the desktop client in a plain browser with a live
 * sidecar, so design tools can inspect the rendered DOM.
 *
 * The client normally reaches the sidecar through Tauri's IPC layer, which a
 * browser lacks. This bridge reverse-proxies the Vite dev server, injects a
 * `__TAURI_INTERNALS__` shim, and carries NDJSON frames over a short-poll
 * endpoint to the daemon's unix socket.
 *
 * Like the Rust host, the bridge is a byte pipe: every daemon frame reaches
 * the frontend as `sidecar-event`, and the frontend dispatcher correlates
 * responses by id. The bridge never inspects a frame's `id`.
 *
 * Loopback only; no repository file is written. OS-level commands with no
 * browser analogue are safe no-ops, so this is an inspection surface, not a
 * full desktop runtime.
 *
 * Usage: node design-bridge.mjs [--dev] [--port 1430]
 *         [--upstream http://localhost:1420] [--socket <daemon.sock>]
 */

import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf("port", "1430"));
const UPSTREAM = argOf("upstream", "http://localhost:1420");
const TACO_HOME = process.env.TACO_HOME ?? join(homedir(), ".taco");
// Match paths.rs: `tauri dev` keeps its daemon under ~/.taco-dev/run so it
// cannot collide with the release profile.
const RUNTIME_DIR = args.includes("--dev")
    ? join(homedir(), ".taco-dev", "run")
    : join(TACO_HOME, "run");
const SOCKET = argOf("socket", process.env.TACO_SOCKET ?? join(RUNTIME_DIR, "sidecar.sock"));

/**
 * The browser-side shim. Implements exactly the Tauri internals the desktop
 * client touches: `invoke` for the IPC commands, `transformCallback` for
 * event handlers, and the window metadata `getCurrentWindow()` reads.
 */
const SHIM = `
(() => {
  const callbacks = new Map();
  let nextId = 1;
  const listeners = new Map();

  // Polling, not long-poll: a request that stays open keeps the page from
  // ever reaching network-idle, and every screenshot tool waits for that
  // before it captures. Each poll returns immediately (empty when nothing
  // is queued), so the page looks idle between polls.
  const POLL_MS = 800;
  let draining = false;
  const queued = [];

  async function pump() {
    if (draining) return;
    draining = true;
    try {
      while (queued.length > 0) {
        const line = queued.shift();
        const handlers = listeners.get("sidecar-event") ?? [];
        for (const id of handlers) {
          const cb = callbacks.get(id);
          if (cb) cb({ event: "sidecar-event", payload: { line } });
        }
      }
    } finally {
      draining = false;
    }
  }

  async function poll() {
    try {
      const res = await fetch("/__bridge/poll", { method: "POST" });
      const text = await res.text();
      if (text) {
        queued.push(text);
        await pump();
      }
    } catch {
      // The bridge is unreachable; retry on the next tick.
    }
    setTimeout(poll, POLL_MS);
  }

  const send = async (line) => {
    await fetch("/__bridge/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line }),
    });
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(callback, once = false) {
      const id = nextId++;
      callbacks.set(
        id,
        once ? (...a) => { callbacks.delete(id); callback(...a); } : callback,
      );
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(path) { return "asset://localhost/" + encodeURIComponent(path); },
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case "workspace_ensure":
          return null;
        case "workspace_send":
          await send(args.line);
          return null;
        case "workspace_dispose_all":
          return null;
        case "plugin:event|listen": {
          const list = listeners.get(args.event) ?? [];
          list.push(args.handler);
          listeners.set(args.event, list);
          return args.handler;
        }
        case "plugin:event|unlisten": {
          const list = listeners.get(args.event) ?? [];
          const i = list.indexOf(args.id);
          if (i >= 0) list.splice(i, 1);
          return null;
        }
        case "default_workspace_dir":
        case "paths_are_dirs":
        case "desktop_config_read":
        case "desktop_config_write":
        case "set_fs_scope":
        case "allow_fs_file":
          return bridgeCommand(cmd, args);
        // The remaining commands are OS-level and have no browser analogue.
        // They must not throw: an unhandled rejection here takes the whole
        // React tree down before the first paint.
        case "boot_mark":
          return null;
        case "upgrade_marker_present":
          return false;
        case "upgrade_apply":
          return "";
        default:
          throw new Error("design-bridge: unsupported command " + cmd);
      }
    },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

  async function bridgeCommand(cmd, args) {
    const res = await fetch("/__bridge/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  }

  poll();
})();
`;

/**
 * Answer the filesystem-backed commands. These need real path access, which
 * the browser does not have, so they run on the bridge side.
 */
function runBridgeCommand(cmd, args) {
    switch (cmd) {
        case "default_workspace_dir":
            return join(TACO_HOME, "workspace");
        case "paths_are_dirs":
            return (args.paths ?? []).map((p) => {
                try {
                    return statSync(p).isDirectory();
                } catch {
                    return false;
                }
            });
        case "desktop_config_read": {
            const path = join(TACO_HOME, "desktop.json");
            return existsSync(path) ? path : null;
        }
        case "desktop_config_write":
        case "set_fs_scope":
        case "allow_fs_file":
            return null;
        default:
            throw new Error(`design-bridge: unsupported command ${cmd}`);
    }
}

/** Reverse-proxy one request to the Vite dev server. */
async function proxyUpstream(req, res) {
    const url = new URL(req.url, UPSTREAM);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    let upstream;
    try {
        upstream = await fetch(url, {
            method: req.method,
            headers: {
                accept: req.headers.accept ?? "*/*",
                "content-type": req.headers["content-type"] ?? "application/json",
            },
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
    } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`upstream error: ${String(err)}`);
        return;
    }

    const type = upstream.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) {
        res.writeHead(upstream.status, { "content-type": type });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
    }

    const html = await upstream.text();
    const injected = html.replace("</head>", `<script src="/__tauri-shim.js"></script></head>`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(injected);
}

/** Read a JSON request body. */
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * The daemon connection. One socket for the whole bridge — the daemon
 * multiplexes workspaces over a single connection, and the frontend's own
 * dispatcher routes frames by the workspace field.
 */
const daemon = connect(SOCKET);

/** Frames the daemon sent but no poll has claimed yet. */
const inbox = [];
let daemonBuffer = "";

daemon.on("data", (chunk) => {
    daemonBuffer += chunk.toString();
    let newline = daemonBuffer.indexOf("\n");
    while (newline >= 0) {
        const frame = daemonBuffer.slice(0, newline).trim();
        daemonBuffer = daemonBuffer.slice(newline + 1);
        if (frame) inbox.push(frame);
        newline = daemonBuffer.indexOf("\n");
    }
});

daemon.on("error", (err) => {
    process.stderr.write(`design-bridge: daemon socket error: ${err.message}\n`);
});

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/__tauri-shim.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(SHIM);
        return;
    }

    if (url.pathname === "/__bridge/send" && req.method === "POST") {
        readJson(req)
            .then(({ line }) => {
                daemon.write(`${line}\n`);
                res.writeHead(204);
                res.end();
            })
            .catch((err) => {
                res.writeHead(400, { "content-type": "text/plain" });
                res.end(String(err));
            });
        return;
    }

    if (url.pathname === "/__bridge/poll" && req.method === "POST") {
        // Answer immediately with the next queued frame, or 204 when the
        // queue is empty. A held-open request would pin the page's network
        // state and stall every screenshot tool waiting for network-idle.
        const frame = inbox.shift();
        if (frame === undefined) {
            res.writeHead(204);
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(frame);
        return;
    }

    if (url.pathname === "/__bridge/command" && req.method === "POST") {
        readJson(req)
            .then(({ cmd, args }) => {
                const body = { result: runBridgeCommand(cmd, args ?? {}) };
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
            })
            .catch((err) => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
            });
        return;
    }

    proxyUpstream(req, res).catch((err) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(err));
    });
});

server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`design-bridge listening on http://127.0.0.1:${PORT}\n`);
    process.stdout.write(`upstream: ${UPSTREAM}\n`);
    process.stdout.write(`daemon socket: ${SOCKET}\n`);
});
