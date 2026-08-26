/**
 * node-tui — a minimal terminal UI that talks to taco-sidecar over NDJSON stdio.
 *
 * Demonstrates `createDefaultSidecarSpawn`, typed `TacoClient`, and reading
 * push frames (`session.event`) while an awaited RPC is in flight.
 *
 * Flow (protocol v2+): start sidecar → handshake() (initialize RPC) →
 * create a session in `cwd` → each line typed at the prompt is sent via
 * `sessionPrompt` and its result printed.
 */

import { createInterface } from "node:readline";
import type { ServerPush } from "@taco-ai/protocol";
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";
import { Terminal } from "./terminal.js";

const cwd = process.argv[2] ?? process.cwd();
const term = new Terminal();

const client = new TacoClient(createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] }));

// ── Push routing ───────────────────────────────────────────────────────────────
// RPC responses are delivered by awaiting the typed methods below — they never
// reach onPush. onPush only fires for server-initiated frames (no id-matched
// pending request): session.event, session.attached, tasks.updated, etc.
client.onPush((frame: ServerPush) => {
    const { method, params } = frame;
    if (method === "session.event") {
        term.print(`[event] ${JSON.stringify(params).slice(0, 120)}`);
    } else if (method === "session.error") {
        term.print(`[ERROR] ${(params as { message?: string }).message ?? "unknown"}`);
    } else {
        term.print(`[push] ${method}`);
    }
});

async function main() {
    await client.start();
    // v2: handshake() sends initialize directly and returns the typed
    // InitializeResult (serverVersion / pid / instanceId). The v1 hello
    // push frame is gone.
    const init = await client.handshake();
    term.print(
        `[init] version=${init.serverVersion} pid=${init.pid} ` + `instanceId=${init.instanceId}`,
    );

    // Create a session in `cwd`. Without an initialPrompt the session is created
    // but not attached, so we pass one to attach + get the first reply in one call.
    const created = await client.sessionCreate({ workspace: cwd, initialPrompt: "hello" });
    const sessionId = created.sessionId;
    term.print(`[session] created + attached: ${sessionId}`);

    term.setPrompt("taco> ");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    for await (const line of rl) {
        const text = line.trim();
        if (!text) {
            term.setPrompt("taco> ");
            continue;
        }
        if (text === "/quit" || text === "/exit") break;

        term.print(`[sending] ${text}`);
        try {
            const result = await client.sessionPrompt(cwd, sessionId, text);
            term.print(`[response] ${JSON.stringify(result).slice(0, 200)}`);
        } catch (err) {
            term.print(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
        }
        term.setPrompt("taco> ");
    }

    rl.close();
    await client.dispose();
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
});
