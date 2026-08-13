/**
 * MCP tool-name mapping — build provider-safe unique names and resolve collisions.
 *
 * Provider-side tool names are restricted to `^[a-zA-Z0-9_-]{1,128}$`, while MCP
 * tool names have no such constraint. We therefore prefix with the server id and
 * rewrite any illegal character to `_`, then dedupe when rewriting truncation
 * collides two distinct tools.
 */

export const MAX_TOOL_NAME_LENGTH = 128;
/** Characters illegal in a provider tool name are replaced with this. */
const SAFE_CHAR = "_";

/** Rewrite a single tool name so it only contains `[a-zA-Z0-9_-]`. */
function sanitizeSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_-]/g, SAFE_CHAR);
}

/**
 * Build the provider tool name for an MCP tool: `mcp__<serverId>__<toolName>`,
 * with illegal characters replaced and the total truncated to 128 chars.
 */
export function mcpToolName(serverId: string, toolName: string): string {
    const raw = `mcp__${serverId}__${toolName}`;
    return sanitizeSegment(raw).slice(0, MAX_TOOL_NAME_LENGTH);
}

/**
 * Resolve a collision against already-taken names by appending `_2`, `_3`, …
 * Keeps the result within the provider's 128-char limit by re-truncating the
 * base when the numeric suffix would overflow it.
 */
export function dedupeName(name: string, taken: ReadonlySet<string>): string {
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name}_${n}`)) {
        n += 1;
    }
    const suffix = `_${n}`;
    if (name.length + suffix.length > MAX_TOOL_NAME_LENGTH) {
        return `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    return `${name}${suffix}`;
}
