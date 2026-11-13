/**
 * Per-run stdio MCP bridge for Codex children. The MCP process contains no
 * host authority: every tool call is authenticated and forwarded over a
 * private local socket to the sidecar process that owns the child identity.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Value } from "typebox/value";
import { tacoHome } from "../../../config/tacoHome.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import {
    type ClaudeCodeCommunicationTools,
    chatSchema,
    communicationDefinitions,
    listSchema,
} from "../claudeCode/claudeCodeCommunication.ts";

export type CodexCommunicationTools = ClaudeCodeCommunicationTools;

export interface CodexCommunicationBridge {
    readonly mcpServer: {
        command: string;
        args: string[];
        env: Record<string, string>;
    };
    close(): Promise<void>;
}

const BRIDGE_SCRIPT = String.raw`
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.TACO_CODEX_BRIDGE_SOCKET;
const token = process.env.TACO_CODEX_BRIDGE_TOKEN;
if (!socketPath || !token) {
  process.stderr.write("missing Codex bridge environment\\n");
  process.exit(2);
}

let ready = false;
let tools = [];
let sequence = 0;
const buffered = [];
const pending = new Map();
const socket = connect(socketPath);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value) => write({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });

socket.on("connect", () => {
  socket.write(JSON.stringify({ type: "hello", token }) + "\n");
});
socket.on("error", (error) => {
  process.stderr.write("Codex bridge socket failed: " + error.message + "\n");
  process.exit(1);
});
socket.on("close", () => process.exit(0));

const socketLines = createInterface({ input: socket, crlfDelay: Infinity });
socketLines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "ready") {
    tools = Array.isArray(message.tools) ? message.tools : [];
    ready = true;
    for (const rpc of buffered.splice(0)) handle(rpc);
    return;
  }
  if (message.type === "response") {
    const id = pending.get(message.id);
    if (id === undefined) return;
    pending.delete(message.id);
    if (message.ok) result(id, {
      content: [{ type: "text", text: JSON.stringify(message.result) ?? "null" }],
    });
    else if (message.protocol) failure(id, -32602, String(message.error ?? "invalid bridge call"));
    else result(id, {
      isError: true,
      content: [{ type: "text", text: String(message.error ?? "bridge call failed") }],
    });
  }
});

function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "taco", version: "1" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    result(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const bridgeId = "bridge-" + (++sequence);
    pending.set(bridgeId, id);
    socket.write(JSON.stringify({
      type: "call",
      id: bridgeId,
      name: params?.name,
      arguments: params?.arguments ?? {},
    }) + "\n");
    return;
  }
  failure(id, -32601, "Method not found: " + method);
}

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!ready) buffered.push(message);
  else handle(message);
});
`;

function socketPath(): string {
    const runDir = join(tacoHome(), "run");
    mkdirSync(runDir, { recursive: true });
    return process.platform === "win32"
        ? `\\\\.\\pipe\\taco-codex-${randomUUID()}`
        : join(runDir, `codex-${randomUUID()}.sock`);
}

function allowedDefinitions(host: CodexCommunicationTools) {
    return communicationDefinitions.filter(
        (tool) => host.allowedNames === undefined || host.allowedNames.includes(tool.name),
    );
}

class BridgeProtocolError extends Error {}

async function invoke(host: CodexCommunicationTools, name: string, input: unknown) {
    if (name === "chatToAgent") {
        if (!Value.Check(chatSchema, input))
            throw new BridgeProtocolError("Invalid chatToAgent arguments");
        return host.chat(input as Parameters<CodexCommunicationTools["chat"]>[0]);
    }
    if (name === "listAgentSessions") {
        if (!Value.Check(listSchema, input))
            throw new BridgeProtocolError("Invalid listAgentSessions arguments");
        return host.list();
    }
    throw new BridgeProtocolError(`Unknown tool: ${name}`);
}

/** Start one authenticated bridge server scoped to a single Codex run. */
export async function createCodexCommunicationBridge(
    host: CodexCommunicationTools,
): Promise<CodexCommunicationBridge> {
    const path = socketPath();
    const token = randomBytes(24).toString("hex");
    const tools = allowedDefinitions(host);
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        const lines = createInterface({ input: socket, crlfDelay: Infinity });
        let authenticated = false;
        lines.on("line", (line) => {
            let message: {
                type?: string;
                token?: string;
                id?: string;
                name?: string;
                arguments?: unknown;
            };
            try {
                message = JSON.parse(line);
            } catch {
                socket.destroy();
                return;
            }
            if (!authenticated) {
                if (message.type !== "hello" || message.token !== token) {
                    socket.destroy();
                    return;
                }
                authenticated = true;
                if (!socket.destroyed && socket.writable) {
                    socket.write(`${JSON.stringify({ type: "ready", tools })}\n`);
                }
                return;
            }
            if (message.type !== "call" || typeof message.id !== "string") return;
            const name = message.name ?? "";
            if (!tools.some((tool) => tool.name === name)) {
                if (!socket.destroyed && socket.writable) {
                    socket.write(
                        `${JSON.stringify({
                            type: "response",
                            id: message.id,
                            ok: false,
                            protocol: true,
                            error: "Unknown tool: " + name,
                        })}\n`,
                    );
                }
                return;
            }
            void invoke(host, name, message.arguments ?? {})
                .then((result) => {
                    if (!socket.destroyed && socket.writable) {
                        socket.write(
                            `${JSON.stringify({ type: "response", id: message.id, ok: true, result })}\n`,
                        );
                    }
                })
                .catch((error: unknown) => {
                    if (!socket.destroyed && socket.writable) {
                        socket.write(
                            `${JSON.stringify({
                                type: "response",
                                id: message.id,
                                ok: false,
                                protocol: error instanceof BridgeProtocolError,
                                error: error instanceof Error ? error.message : String(error),
                            })}\n`,
                        );
                    }
                });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        mcpServer: {
            command: process.execPath,
            args: ["--input-type=module", "--eval", BRIDGE_SCRIPT],
            env: {
                ...scrubbedProcessEnv(),
                TACO_CODEX_BRIDGE_SOCKET: path,
                TACO_CODEX_BRIDGE_TOKEN: token,
            },
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (process.platform !== "win32") rmSync(path, { force: true });
        },
    };
}

export { BRIDGE_SCRIPT };
