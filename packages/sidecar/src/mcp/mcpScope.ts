/**
 * Process-level ownership for MCP tool providers.
 *
 * A workspace leases a provider for the effective server configuration. The
 * provider owns the live transports, while the scope owns how long those
 * transports stay alive across workspace runtimes.
 */

import {
    createMcpToolProvider,
    type DiscoverMcpToolsArgs,
    type McpToolProvider,
} from "./mcpToolProvider.ts";

interface ScopeEntry {
    refs: number;
    provider: Promise<McpToolProvider>;
    released: Set<symbol>;
}

export interface McpProviderLease {
    readonly provider: McpToolProvider;
    release(): Promise<void>;
}

export class McpScope {
    private readonly entries = new Map<string, ScopeEntry>();

    async acquire(args: DiscoverMcpToolsArgs): Promise<McpProviderLease> {
        const key = stableJson(args.servers);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                refs: 0,
                provider: Promise.resolve(createMcpToolProvider(args)),
                released: new Set(),
            };
            this.entries.set(key, entry);
            entry.provider.catch(() => {
                if (this.entries.get(key) === entry) this.entries.delete(key);
            });
        }
        entry.refs++;
        const token = Symbol("mcp-provider-lease");
        const current = entry;
        const provider = await current.provider;

        return {
            provider,
            release: async () => {
                if (current.released.has(token)) return;
                current.released.add(token);
                current.refs--;
                if (current.refs !== 0 || this.entries.get(key) !== current) return;
                this.entries.delete(key);
                await provider.dispose();
            },
        };
    }

    async dispose(): Promise<void> {
        const entries = [...this.entries.values()];
        this.entries.clear();
        const providers = await Promise.allSettled(entries.map((entry) => entry.provider));
        await Promise.all(
            providers.flatMap((result) =>
                result.status === "fulfilled"
                    ? [result.value.dispose().catch(() => undefined)]
                    : [],
            ),
        );
    }
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
