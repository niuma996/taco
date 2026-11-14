import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { BridgeRequest, BridgeResponse } from "./codexCommunicationProtocol.ts";

// The SDK does not expose a named cancellation code. Keep it distinct from disconnects.
const REQUEST_CANCELLED = -32800;

/** Run the isolated MCP relay; importing this module does not open sockets or stdio. */
export async function runCodexCommunicationBridge(): Promise<void> {
    const socketPath = process.env.TACO_CODEX_BRIDGE_SOCKET;
    const token = process.env.TACO_CODEX_BRIDGE_TOKEN;
    if (!socketPath || !token) {
        process.stderr.write("missing Codex bridge environment\n");
        process.exitCode = 2;
        return;
    }

    const server = new Server({ name: "taco", version: "1" }, { capabilities: { tools: {} } });
    const transport = new StdioServerTransport();
    const socket = connect(socketPath);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const pending = new Map<
        string,
        { resolve(result: CallToolResult): void; reject(error: Error): void }
    >();
    let sequence = 0;
    let stopped = false;
    let resolveReady!: (tools: Tool[]) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Tool[]>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const send = (request: BridgeRequest) => {
        if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(request)}\n`);
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        const error = new McpError(ErrorCode.ConnectionClosed, "Codex bridge socket closed");
        rejectReady(error);
        for (const call of pending.values()) call.reject(error);
        pending.clear();
        lines.close();
        socket.destroy();
        process.stdin.off("end", stop);
        process.stdin.off("close", stop);
        process.stdin.off("error", fail);
        process.stdout.off("error", fail);
        void server.close();
    };
    const fail = (error: Error) => {
        process.stderr.write(`Codex bridge socket failed: ${error.message}\n`);
        process.exitCode = 1;
        stop();
    };
    server.onclose = stop;
    socket.on("error", fail);
    socket.once("close", stop);
    socket.once("connect", () => send({ type: "hello", token }));
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    process.stdin.on("error", fail);
    process.stdout.on("error", fail);
    lines.on("line", (line) => {
        let response: BridgeResponse;
        try {
            response = JSON.parse(line);
        } catch {
            fail(new Error("Invalid Codex bridge response"));
            return;
        }
        if (response.type === "ready") {
            resolveReady(response.tools);
        } else if (response.type === "response") {
            const call = pending.get(response.id);
            if (!call) return;
            pending.delete(response.id);
            if (response.ok) {
                call.resolve({
                    content: [{ type: "text", text: JSON.stringify(response.result) ?? "null" }],
                });
            } else if (response.code !== undefined) {
                call.reject(new McpError(response.code, response.error));
            } else {
                call.resolve({ isError: true, content: [{ type: "text", text: response.error }] });
            }
        }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await ready }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        if (stopped || signal.aborted)
            throw new McpError(ErrorCode.ConnectionClosed, "Codex bridge closed");
        const id = `bridge-${++sequence}`;
        const abort = () => {
            const call = pending.get(id);
            pending.delete(id);
            send({ type: "cancel", id });
            call?.reject(new McpError(REQUEST_CANCELLED, "Codex bridge call cancelled"));
        };
        try {
            return await new Promise<CallToolResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                signal.addEventListener("abort", abort, { once: true });
                send({ type: "call", id, name: params.name, arguments: params.arguments ?? {} });
            });
        } finally {
            pending.delete(id);
            signal.removeEventListener("abort", abort);
        }
    });
    try {
        // Attach stdio immediately so EOF and early MCP requests are handled by the SDK.
        await server.connect(transport);
        await ready;
    } catch (error) {
        if (!stopped) fail(error instanceof Error ? error : new Error(String(error)));
    }
}

// npm installs and macOS temporary directories may reach the entry through symlinks.
if (process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])) {
    await runCodexCommunicationBridge();
}
