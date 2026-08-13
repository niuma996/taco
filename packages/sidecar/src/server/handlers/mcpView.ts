/**
 * Shared MCP projection helpers — single source of truth for mapping a raw
 * `McpServerConfig` (may carry secret-bearing fields) to its safe view.
 *
 * `settings.get` / `settings.write` use this so the desktop cache / IPC frame
 * never carries `env` / `headers` / `command` / `args` / `url`; the per-entry
 * `mcp.getConfig` handler returns the raw config directly and does not project.
 */

import type { McpServerConfigView, TacoGlobalConfigShape } from "@taco-ai/protocol";

/**
 * Map a raw `McpServerConfig` to its safe view. Strips every field that can
 * carry a secret or arbitrary executable path: `env`, `headers`, `command`,
 * `args`, `url`. The desktop cache / IPC payload never carries these.
 */
export function mcpServerToView(
    m: NonNullable<TacoGlobalConfigShape["mcpServers"]>[number],
): McpServerConfigView {
    const out: McpServerConfigView = {
        id: m.id,
        transport: m.transport,
        ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
        ...(m.timeoutMs !== undefined ? { timeoutMs: m.timeoutMs } : {}),
        ...(m.alwaysLoaded !== undefined ? { alwaysLoaded: m.alwaysLoaded } : {}),
    };
    return out;
}
