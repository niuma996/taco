/**
 * Process-level ownership for MCP tool providers.
 *
 * A workspace leases a provider for the effective server configuration. The
 * provider owns the live transports, while the scope owns how long those
 * transports stay alive across workspace runtimes.
 */

import type { McpServerConfig } from "@taco-ai/protocol";
import {
    createMcpToolProvider,
    type DiscoverMcpToolsArgs,
    type McpToolProvider,
} from "./mcpToolProvider.ts";

interface ScopeEntry {
    refs: number;
    provider: McpToolProvider;
    released: Set<symbol>;
}

export interface McpProviderLease {
    readonly provider: McpToolProvider;
    release(): Promise<void>;
}

/**
 * A lease on a provider no other workspace can see. IM workspaces use this:
 * stateful MCP servers (browser sessions, DB transactions) must not carry one
 * conversation's state into another, so their transports are never shared.
 */
export function createPrivateMcpLease(args: DiscoverMcpToolsArgs): McpProviderLease {
    const provider = createMcpToolProvider(args);
    let released = false;
    return {
        provider,
        release: async () => {
            if (released) return;
            released = true;
            await provider.dispose();
        },
    };
}

export class McpScope {
    private readonly entries = new Map<string, ScopeEntry>();

    /** The provider keeps the first leaseholder's logger; later leases share its output. */
    acquire(args: DiscoverMcpToolsArgs): McpProviderLease {
        const key = stableJson(args.servers.map(transportIdentity));
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { refs: 0, provider: createMcpToolProvider(args), released: new Set() };
            this.entries.set(key, entry);
        }
        entry.refs++;
        const token = Symbol("mcp-provider-lease");
        const current = entry;

        return {
            provider: current.provider,
            release: async () => {
                if (current.released.has(token)) return;
                current.released.add(token);
                current.refs--;
                if (current.refs !== 0 || this.entries.get(key) !== current) return;
                this.entries.delete(key);
                await current.provider.dispose();
            },
        };
    }

    async dispose(): Promise<void> {
        const entries = [...this.entries.values()];
        this.entries.clear();
        await Promise.all(entries.map((entry) => entry.provider.dispose().catch(() => undefined)));
    }
}

/** Only stdio spawns into `cwd`; letting it split the key would stop HTTP servers from sharing. */
function transportIdentity(server: McpServerConfig): McpServerConfig {
    if (server.transport === "stdio" || server.cwd === undefined) return server;
    const { cwd: _cwd, ...rest } = server;
    return rest;
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
