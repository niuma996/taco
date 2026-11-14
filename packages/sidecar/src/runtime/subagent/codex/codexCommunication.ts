/** Per-run authenticated socket authority for the Codex stdio MCP child. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { tacoHome } from "../../../config/tacoHome.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import {
    type AgentCommunicationTools,
    chatSchema,
    communicationDefinitions,
    listSchema,
} from "../agentCommunication.ts";
import type { BridgeRequest, BridgeResponse } from "./codexCommunicationProtocol.ts";

export interface CodexCommunicationTools extends AgentCommunicationTools {
    // Cancellation releases bridge state; handlers may observe it without undoing queued actions.
    chat(
        args: Parameters<AgentCommunicationTools["chat"]>[0],
        signal?: AbortSignal,
    ): Promise<unknown>;
    list(signal?: AbortSignal): Promise<unknown>;
}

export interface CodexCommunicationBridge {
    readonly mcpServer: {
        command: string;
        args: string[];
        env: Record<string, string>;
    };
    close(): Promise<void>;
}

function bridgeArgs(): string[] {
    // A bundle must use its sibling artifact, including portable installs without node_modules.
    const source = import.meta.url.endsWith(".ts");
    const entry = join(import.meta.dirname, `codexCommunicationBridge.${source ? "ts" : "mjs"}`);
    if (!existsSync(entry)) throw new Error(`Missing Codex communication bridge entry: ${entry}`);
    return [
        ...(source
            ? ["--disable-warning=ExperimentalWarning", "--experimental-transform-types"]
            : []),
        entry,
    ];
}

function socketPath(): string {
    const runDir = join(tacoHome(), "run");
    mkdirSync(runDir, { recursive: true });
    return process.platform === "win32"
        ? `\\\\.\\pipe\\taco-codex-${randomUUID()}`
        : join(runDir, `codex-${randomUUID()}.sock`);
}

class BridgeProtocolError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(message);
    }
}

async function invoke(
    host: CodexCommunicationTools,
    name: string,
    input: unknown,
    signal: AbortSignal,
) {
    if (name === "chatToAgent") {
        if (!Value.Check(chatSchema, input))
            throw new BridgeProtocolError(ErrorCode.InvalidParams, "Invalid chatToAgent arguments");
        return host.chat(input, signal);
    }
    if (name === "listAgentSessions") {
        if (!Value.Check(listSchema, input))
            throw new BridgeProtocolError(
                ErrorCode.InvalidParams,
                "Invalid listAgentSessions arguments",
            );
        return host.list(signal);
    }
    throw new BridgeProtocolError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
}

/** Start one authenticated bridge server scoped to a single Codex run. */
export async function createCodexCommunicationBridge(
    host: CodexCommunicationTools,
): Promise<CodexCommunicationBridge> {
    const args = bridgeArgs();
    const path = socketPath();
    const token = randomBytes(24).toString("hex");
    // Freeze the run's grant and callbacks: later host mutations cannot change its authority.
    const tools = communicationDefinitions.filter(
        (tool) => host.allowedNames === undefined || host.allowedNames.includes(tool.name),
    );
    const capturedHost = { chat: host.chat.bind(host), list: host.list.bind(host) };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        const active = new Map<string, AbortController>();
        const lines = createInterface({ input: socket, crlfDelay: Infinity });
        socket.once("close", () => {
            sockets.delete(socket);
            lines.close();
            for (const controller of active.values()) controller.abort();
            active.clear();
        });
        socket.on("error", () => socket.destroy());
        const send = (response: BridgeResponse) => {
            if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(response)}\n`);
        };
        let authenticated = false;
        lines.on("line", (line) => {
            let message: BridgeRequest;
            try {
                message = JSON.parse(line);
                if (!message || typeof message !== "object")
                    throw new Error("Invalid bridge message");
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
                send({
                    type: "ready",
                    tools: tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
                });
                return;
            }
            if (message.type === "cancel") {
                const controller = active.get(message.id);
                active.delete(message.id);
                controller?.abort();
                return;
            }
            if (message.type !== "call" || typeof message.id !== "string") return;
            const id = message.id;
            if (active.has(id)) {
                socket.destroy();
                return;
            }
            if (!tools.some((tool) => tool.name === message.name)) {
                send({
                    type: "response",
                    id,
                    ok: false,
                    code: ErrorCode.MethodNotFound,
                    error: `Unknown tool: ${message.name}`,
                });
                return;
            }
            const controller = new AbortController();
            active.set(id, controller);
            void invoke(capturedHost, message.name, message.arguments ?? {}, controller.signal)
                .then((result) => {
                    if (!controller.signal.aborted)
                        send({ type: "response", id, ok: true, result });
                })
                .catch((error: unknown) => {
                    if (!controller.signal.aborted)
                        send({
                            type: "response",
                            id,
                            ok: false,
                            code: error instanceof BridgeProtocolError ? error.code : undefined,
                            error: error instanceof Error ? error.message : String(error),
                        });
                })
                .finally(() => {
                    if (active.get(id) === controller) active.delete(id);
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
            args,
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
