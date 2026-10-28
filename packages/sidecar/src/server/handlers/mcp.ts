/**
 * mcp.* handlers — server discovery and health status.
 *
 * `mcp.listServers` connects to every configured server (or the subset selected
 * by the optional `ids` param), calls listTools, and returns a per-server
 * snapshot of connectivity and the tool list.  This is a read-only diagnostic
 * endpoint — actual MCP tool calls go through the dynamic-tool machinery in the
 * session harness (addTools, etc.).
 *
 * Disabled servers (enabled === false) are skipped without spawning: returning
 * `status: "skipped"` avoids spawning stdio child processes that the user has
 * explicitly turned off, which is wasted work and noisy in logs. The runtime
 * candidate construction in `discoverMcpTools` already filters disabled
 * servers, so this just keeps the diagnostic consistent.
 *
 * Pass `forceProbe: true` to override the skip — useful for the UI's "refresh
 * status" button when a user toggles a server back on and wants to verify it.
 */

import type {
    McpDeleteConfigResult,
    McpGetConfigResult,
    McpMutateConfigResult,
    McpServerConfig,
    McpServerView,
} from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";
import {
    readGlobalConfig,
    readMcpServers,
    updateGlobalConfig,
    validateMcpServers,
} from "../../config/config.ts";
import { createLogger } from "../../lib/logger.ts";
import { createMcpClient, type McpClientFactory } from "../../mcp/mcpClient.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { mcpServerToView } from "./mcpView.ts";

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Probe every configured MCP server in parallel and return a per-server
 * snapshot of connectivity + tool list.
 *
 * `clientFactory` is injectable for tests; the handler passes `createMcpClient`
 * in production. Each entry is tried independently — a single failing server
 * contributes an `error` view but never aborts the rest. When `skipDisabled`
 * is true, servers with `enabled === false` short-circuit to a `skipped` view
 * without invoking `clientFactory`.
 */
export async function probeMcpServers(
    allServers: readonly McpServerConfig[],
    clientFactory: McpClientFactory,
    skipDisabled = true,
): Promise<McpServerView[]> {
    const results = await Promise.all(
        allServers.map(async (s): Promise<McpServerView> => {
            if (skipDisabled && s.enabled === false) {
                return {
                    id: s.id,
                    transport: s.transport,
                    status: "skipped",
                    toolCount: 0,
                    tools: [],
                };
            }
            try {
                const handle = await clientFactory(s);
                try {
                    const tools = await handle.listTools();
                    // Closing after a successful probe is housekeeping, not a
                    // signal of anything wrong. If close() throws (e.g. the
                    // remote already hung up), we still want to report
                    // {status: "ok"} — the probe data is valid.
                    await handle.close().catch(() => undefined);
                    return {
                        id: s.id,
                        transport: s.transport,
                        status: "ok",
                        toolCount: tools.length,
                        tools: tools.map((t) => t.name),
                    };
                } catch (innerErr) {
                    // listTools can throw after the transport handshake
                    // succeeded; without this the stdio child / HTTP socket
                    // outlives the probe. close() is idempotent.
                    await handle.close().catch(() => undefined);
                    throw innerErr;
                }
            } catch (err) {
                return {
                    id: s.id,
                    transport: s.transport,
                    status: "error",
                    toolCount: 0,
                    tools: [],
                    connectError: messageOf(err),
                };
            }
        }),
    );
    return results;
}

export function registerMcpHandlers(): void {
    registerMethod(
        "mcpListServers",
        false,
        async ({
            params,
        }: MethodCtx<{ ids?: string[]; forceProbe?: boolean }>): Promise<{
            servers: McpServerView[];
        }> => {
            const cfg = readGlobalConfig();
            const allServers: McpServerConfig[] = cfg.mcpServers ?? [];
            const targetIds = params.ids;
            const servers =
                targetIds !== undefined
                    ? allServers.filter((s) => targetIds.includes(s.id))
                    : allServers;

            return {
                servers: await probeMcpServers(
                    servers,
                    (s) => createMcpClient(s, createLogger("mcp.listServers")),
                    !params.forceProbe,
                ),
            };
        },
    );

    registerMethod("mcpGetConfig", false, async ({ params }): Promise<McpGetConfigResult> => {
        return { config: requireServerConfig(readMcpServers(), params.id) };
    });

    registerMethod(
        "mcpCreateConfig",
        false,
        async ({ params, server }): Promise<McpMutateConfigResult> => {
            // validateMcpServers throws a plain Error on malformed input
            // (duplicate id, bad transport, invalid url, ...) — map it to a
            // contract error here so clients see invalid_params, not internal.
            try {
                updateGlobalConfig((current) => ({
                    mcpServers: validateMcpServers(
                        [...(current.mcpServers ?? []), params.config],
                        "mcp.createConfig",
                    ),
                }));
                // Invalidate every workspace so the next ensureWorkspace
                // discovers the new server's candidates. reloadMcpServers is
                // optional on the surface (test stubs may omit it).
                await server?.reloadMcpServers?.();
                return { server: mcpServerToView(params.config), requiresRestart: true };
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
    );

    registerMethod(
        "mcpUpdateConfig",
        false,
        async ({ params, server }): Promise<McpMutateConfigResult> => {
            if (typeof params?.id !== "string" || params.id.length === 0) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "id is required");
            }
            if (!params.patch || typeof params.patch !== "object") {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "patch is required");
            }
            // Same malformed-input mapping as mcp.createConfig — a bad patch
            // (e.g. duplicate id against another server) must surface as
            // invalid_params rather than internal.
            try {
                const next = updateGlobalConfig((current) => {
                    const servers = current.mcpServers ?? [];
                    const target = requireServerConfig(servers, params.id);
                    const merged = { ...target, ...params.patch, id: params.id };
                    return {
                        mcpServers: validateMcpServers(
                            servers.map((s) => (s.id === params.id ? merged : s)),
                            "mcp.updateConfig",
                        ),
                    };
                });
                await server?.reloadMcpServers?.();
                return {
                    server: mcpServerToView(requireServerConfig(next.mcpServers ?? [], params.id)),
                    requiresRestart: true,
                };
            } catch (e) {
                if (e instanceof RpcHandlerError) throw e;
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
    );

    registerMethod(
        "mcpDeleteConfig",
        false,
        async ({ params, server }): Promise<McpDeleteConfigResult> => {
            if (typeof params?.id !== "string" || params.id.length === 0) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "id is required");
            }
            updateGlobalConfig((current) => {
                const servers = current.mcpServers ?? [];
                requireServerConfig(servers, params.id);
                return { mcpServers: servers.filter((s) => s.id !== params.id) };
            });
            await server?.reloadMcpServers?.();
            return { deleted: params.id, requiresRestart: true };
        },
    );
}

/**
 * Find a server by id in the configured list or throw `not_found`. Centralized
 * so get/update/delete share one lookup + error contract.
 */
function requireServerConfig(servers: readonly McpServerConfig[], id: string): McpServerConfig {
    const found = servers.find((s) => s.id === id);
    if (!found) throw new RpcHandlerError(ErrorCodes.NotFound, `mcp server not found: ${id}`);
    return found;
}
