/**
 * MCP tool provider — discover all configured MCP servers and expose their
 * tools as dynamic-tool candidates.
 *
 * Discovery runs once at workspace init: each enabled server is connected and
 * its tool list fetched. A failing server contributes zero candidates and is
 * logged, never blocking other servers or workspace startup. Connections stay
 * open after discovery so later callTool calls reuse them; dispose() closes all.
 */

import type { McpServerConfig } from "@taco-ai/protocol";
import type { Logger } from "../lib/logger.ts";
import type { ToolCandidate, ToolLoadingMode } from "../runtime/deferredToolRegistry.ts";
import {
    createMcpClient,
    type McpClientFactory,
    type McpClientHandle,
    type McpToolInfo,
} from "./mcpClient.ts";
import { createMcpToolAdapter } from "./mcpToolAdapter.ts";
import { dedupeName, mcpToolName } from "./mcpToolName.ts";

export interface McpToolProvider {
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
    const enabled = args.servers.filter((s) => s.enabled !== false);
    const clients = args.clientFactory;

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
                // listTools can throw after the transport handshake succeeded;
                // without this the stdio child / HTTP socket lives until
                // process exit. createMcpClient.close() is idempotent (closed
                // flag), so this is safe even if the SDK already tore itself
                // down internally.
                if (handle) await handle.close().catch(() => undefined);
                args.log.warn(`mcp server ${cfg.id} discovery failed: ${messageOf(err)}`);
                return undefined;
            }
        }),
    );
    const discovered = results.filter((s): s is DiscoveredServer => s !== undefined);

    // Registry construction requires unique names; dedupe across servers.
    const taken = new Set<string>();
    const candidates: ToolCandidate[] = [];
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

    return {
        candidates: () => candidates,
        async dispose() {
            await Promise.allSettled(discovered.map((s) => s.handle.close().catch(() => {})));
        },
    };
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
