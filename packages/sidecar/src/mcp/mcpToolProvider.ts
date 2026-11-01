/**
 * MCP tool provider — discover all configured MCP servers and expose their
 * tools as dynamic-tool candidates.
 *
 * A provider is a cheap workspace catalog until ready() is called. The first
 * caller that needs tool definitions connects enabled servers and fetches their
 * lists. A failing server contributes zero candidates and is logged; dispose()
 * closes any transports that were actually opened.
 */

import type { McpServerConfig } from "@taco-ai/protocol";
import type { Logger } from "../lib/logger.ts";
import type { ToolCandidate, ToolLoadingMode } from "../runtime/harness/deferredToolRegistry.ts";
import {
    createMcpClient,
    type McpClientFactory,
    type McpClientHandle,
    type McpToolInfo,
} from "./mcpClient.ts";
import { createMcpToolAdapter } from "./mcpToolAdapter.ts";
import { dedupeName, mcpToolName } from "./mcpToolName.ts";

export interface McpToolProvider {
    /** Connect and discover tools once; callers may invoke this at first use. */
    ready(): Promise<void>;
    candidates(): readonly ToolCandidate[];
    dispose(): Promise<void>;
}

export interface DiscoverMcpToolsArgs {
    servers: readonly McpServerConfig[];
    clientFactory?: McpClientFactory;
    log: Logger;
}

interface DiscoveredServer {
    cfg: McpServerConfig;
    handle: McpClientHandle;
    tools: McpToolInfo[];
}

export async function discoverMcpTools(args: DiscoverMcpToolsArgs): Promise<McpToolProvider> {
    const provider = createMcpToolProvider(args);
    await provider.ready();
    return provider;
}

export function createMcpToolProvider(args: DiscoverMcpToolsArgs): McpToolProvider {
    const enabled = args.servers.filter((s) => s.enabled !== false);
    // Process-wide kill-switch for MCP discovery. Some stdio MCP servers
    // (notably @dbx-app/mcp-server + its native child) consume the
    // daemon's libuv thread pool while they handshake, which leaves the
    // event loop unable to answer pending RPCs. The desktop + CLI both
    // forward TACO_DISABLE_MCP=1 when the user disables MCPs via the
    // tray / Debug tab so a stuck discovery never blocks the session
    // list the user is actively waiting on.
    if (process.env.TACO_DISABLE_MCP === "1") {
        args.log.warn(
            "MCP discovery disabled by TACO_DISABLE_MCP=1; session will run without MCP tools",
        );
        return emptyProvider();
    }
    const clients = args.clientFactory;
    let discovery: Promise<void> | undefined;
    let discovered: DiscoveredServer[] = [];
    let candidates: ToolCandidate[] = [];

    const ready = async (): Promise<void> => {
        discovery ??= discover();
        await discovery;
    };

    async function discover(): Promise<void> {
        // Connect + listTools per server in parallel: a slow or failing server
        // must not add its own connect timeout to every other server's startup.
        const results = await Promise.all(
            enabled.map(async (cfg): Promise<DiscoveredServer | undefined> => {
                let handle: McpClientHandle | undefined;
                try {
                    handle = clients ? await clients(cfg) : await createMcpClient(cfg, args.log);
                    const tools = await handle.listTools();
                    return { cfg, handle, tools };
                } catch (err) {
                    if (handle) await handle.close().catch(() => undefined);
                    args.log.warn(`mcp server ${cfg.id} discovery failed: ${messageOf(err)}`);
                    return undefined;
                }
            }),
        );
        discovered = results.filter((s): s is DiscoveredServer => s !== undefined);

        const taken = new Set<string>();
        candidates = [];
        for (const server of discovered) {
            const always = new Set(server.cfg.alwaysLoaded ?? []);
            for (const tool of server.tools) {
                const name = dedupeName(mcpToolName(server.cfg.id, tool.name), taken);
                taken.add(name);
                const loading: ToolLoadingMode = always.has(tool.name) ? "always" : "deferred";
                const info = tool;
                candidates.push({
                    name,
                    summary: tool.description ?? `MCP tool ${tool.name} (${server.cfg.id})`,
                    loading,
                    source: "mcp",
                    load: async () =>
                        createMcpToolAdapter({
                            name,
                            serverId: server.cfg.id,
                            rawName: tool.name,
                            handle: server.handle,
                            info,
                        }),
                });
            }
        }
    }

    return {
        candidates: () => candidates,
        ready,
        async dispose() {
            if (!discovery) return;
            await discovery.catch(() => undefined);
            await Promise.allSettled(discovered.map((s) => s.handle.close().catch(() => {})));
        },
    };
}

function emptyProvider(): McpToolProvider {
    return {
        ready: async () => {},
        candidates: () => [],
        dispose: async () => {},
    };
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
