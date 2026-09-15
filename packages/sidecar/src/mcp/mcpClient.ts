/**
 * MCP client — thin wrapper over @modelcontextprotocol/sdk for the transport
 * kinds we support (stdio + Streamable HTTP). The `McpClientHandle` interface
 * keeps this module injectable in unit tests.
 */

import { existsSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@taco-ai/protocol";
import { withDeadline } from "../lib/async.ts";
import type { Logger } from "../lib/logger.ts";
import { scrubbedProcessEnv } from "../runtime/models/providerKeyStore.ts";

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema: unknown;
}

export interface McpCallResult {
    content: unknown[];
    isError?: boolean;
}

export interface McpClientHandle {
    /** Server id this handle belongs to (used in error messages). */
    readonly serverId: string;
    listTools(signal?: AbortSignal): Promise<McpToolInfo[]>;
    callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
    close(): Promise<void>;
}

export type McpClientFactory = (cfg: McpServerConfig) => Promise<McpClientHandle>;

export const DEFAULT_MCP_TIMEOUT_MS = 15_000;

const CLIENT_NAME = "taco-sidecar";
const CLIENT_VERSION = "0.1.0";

/** Forward the stdio child's stderr to our logger, keyed by server id. */
function pipeStderr(transport: StdioClientTransport, serverId: string, log: Logger): void {
    const stream = transport.stderr;
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trimEnd();
        if (line) log.warn(`mcp ${serverId} [stderr] ${line}`);
    });
    stream.on("error", (err: Error) => {
        log.warn(`mcp ${serverId} stderr stream error: ${err.message}`);
    });
}

/**
 * Helper for `withDeadline` calls in this module: packs MCP-specific
 * `serverId` / `op` into the unified `label` so the error message keeps
 * reading `mcp server <id>: <op> timed out after <ms>ms` exactly as before.
 *
 * The `externalSignal` and `onTimeout` pass through to `withDeadline`; this
 * is the only difference from `withDeadline`'s signature — the rest of the
 * timeout logic (timer, signal fusion, cleanup race, structured error) now
 * lives in one place.
 */
async function mcpDeadline<T>(
    promise: Promise<T>,
    args: {
        timeoutMs: number;
        serverId: string;
        op: string;
        externalSignal?: AbortSignal;
        onTimeout?: () => void | Promise<void>;
    },
): Promise<T> {
    return withDeadline(promise, {
        timeoutMs: args.timeoutMs,
        code: "MCP_TIMEOUT",
        label: `mcp server ${args.serverId}: ${args.op}`,
        ...(args.externalSignal !== undefined ? { externalSignal: args.externalSignal } : {}),
        ...(args.onTimeout !== undefined ? { onTimeout: args.onTimeout } : {}),
    });
}

/**
 * Connect to one MCP server and wrap the resulting client. Connection (the
 * initialize handshake) runs under `timeoutMs`; failures throw an error that
 * names the server id so callers can isolate a single bad server.
 */
export async function createMcpClient(cfg: McpServerConfig, log: Logger): Promise<McpClientHandle> {
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

    // closeOnce lives OUTSIDE the try block so it is reachable from both the
    // outer catch (handle construction never returned) and the handle that is
    // eventually returned. Without this, a timeout that triggers the outer
    // catch's client.close() closes the SDK before handle.close() is even
    // installable, and a later handle.close() from dispose() would attempt a
    // second SDK close on a closed client.
    let closed = false;
    const closeOnce = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
            await client.close();
        } catch {
            // The SDK does not guarantee close() is idempotent. If the first
            // close throws (e.g. the stdio child is already dead and the
            // transport errors), allow a future caller to try again rather
            // than leaving the resource release permanently stuck.
            closed = false;
        }
    };

    // The SDK's Client.connect does not accept an AbortSignal in the version
    // we depend on; if the deadline wins during connect, the local reject
    // returns but the SDK is still mid-handshake — the outer catch below
    // closes the client via closeOnce(), which kills the stdio child /
    // aborts the in-flight HTTP request so the process doesn't outlive its
    // timeout. onTimeout stays empty here because closeOnce is the single
    // close point.
    try {
        if (cfg.transport === "stdio") {
            if (!cfg.command) {
                throw new Error(`mcp server ${cfg.id}: stdio transport requires a command`);
            }
            // A missing/non-directory cwd makes spawn fail with ENOENT naming the
            // *command* path, which reads as "your command is wrong" and sends
            // anyone debugging it down the wrong trail. Check it up front so the
            // message points at the real culprit. This happens for real: the
            // desktop's default workspace lives under /tmp, which the OS prunes.
            if (cfg.cwd !== undefined) {
                if (!existsSync(cfg.cwd)) {
                    throw new Error(
                        `mcp server ${cfg.id}: working directory does not exist: ${cfg.cwd}`,
                    );
                }
                if (!statSync(cfg.cwd).isDirectory()) {
                    throw new Error(
                        `mcp server ${cfg.id}: working directory is not a directory: ${cfg.cwd}`,
                    );
                }
            }
            // Inherit our own environment, then layer the server's overrides.
            // The SDK always passes its `env` option through to the spawn call,
            // and its own default (`getDefaultEnvironment()`) only populates
            // anything on win32 — on macOS/Linux it yields `{}`, so a child
            // spawned without this merge gets an empty environment and fails
            // with ENOENT the moment it needs PATH (which `command: "node"`,
            // nvm shims, and most launcher scripts all do).
            const env = scrubbedProcessEnv();
            const stdio = new StdioClientTransport({
                command: cfg.command,
                args: cfg.args,
                env: { ...env, ...cfg.env },
                cwd: cfg.cwd,
                stderr: "pipe",
            });
            pipeStderr(stdio, cfg.id, log);
            await mcpDeadline(client.connect(stdio), {
                timeoutMs,
                serverId: cfg.id,
                op: "connect",
            });
        } else {
            if (!cfg.url) {
                throw new Error(`mcp server ${cfg.id}: http transport requires a url`);
            }
            const http = new StreamableHTTPClientTransport(new URL(cfg.url), {
                requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
            });
            await mcpDeadline(client.connect(http), {
                timeoutMs,
                serverId: cfg.id,
                op: "connect",
            });
        }
    } catch (err) {
        // Connect never returned a handle to the caller; without this branch
        // the stdio child / HTTP socket would leak. closeOnce handles a
        // throwing close() by clearing the flag so the next caller can retry.
        await closeOnce();
        throw err;
    }

    return {
        serverId: cfg.id,
        async listTools(signal) {
            const { tools } = await mcpDeadline(
                client.listTools(undefined, { signal, timeout: timeoutMs }),
                {
                    timeoutMs,
                    serverId: cfg.id,
                    op: "listTools",
                    externalSignal: signal,
                    onTimeout: () => closeOnce(),
                },
            );
            return tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
        },
        async callTool(name, args, signal) {
            const result = await mcpDeadline(
                client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
                    signal,
                    timeout: timeoutMs,
                }),
                {
                    timeoutMs,
                    serverId: cfg.id,
                    op: `callTool(${name})`,
                    externalSignal: signal,
                    onTimeout: () => closeOnce(),
                },
            );
            // Plain (non-task) calls return the content/ isError shape; the union
            // with toolResult only appears for task-based execution, which we never use.
            const { content, isError } = result as {
                content?: unknown[];
                isError?: boolean;
            };
            return {
                content: (content ?? []) as unknown[],
                isError,
            };
        },
        async close() {
            await closeOnce();
        },
    };
}
