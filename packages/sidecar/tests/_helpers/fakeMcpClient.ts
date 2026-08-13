/**
 * Fake MCP client handle for unit tests — records calls like FakeToolCollection.
 */

import type { McpClientHandle, McpToolInfo } from "../../src/mcp/mcpClient.ts";

export interface FakeCallRecord {
    name: string;
    args: unknown;
    signal?: AbortSignal;
}

export class FakeMcpClient implements McpClientHandle {
    serverId: string;
    tools: McpToolInfo[];
    /** Per-tool canned responses; a throwing function simulates a failed call. */
    callImpl: (name: string, args: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
    calls: FakeCallRecord[] = [];
    closed = false;
    /** When set, close() throws with this error on each call (counter resets
     *  after each throw). Useful for exercising closeOnce retry semantics. */
    closeError: Error | null = null;
    closeCalls = 0;

    constructor(
        serverId: string,
        tools: McpToolInfo[],
        callImpl: FakeMcpClient["callImpl"] = async () => ({
            content: [{ type: "text", text: "ok" }],
        }),
    ) {
        this.serverId = serverId;
        this.tools = tools;
        this.callImpl = callImpl;
    }

    async listTools(): Promise<McpToolInfo[]> {
        return this.tools;
    }

    async callTool(
        name: string,
        args: unknown,
        signal?: AbortSignal,
    ): Promise<{ content: unknown[]; isError?: boolean }> {
        this.calls.push({ name, args, signal });
        return this.callImpl(name, args);
    }

    async close(): Promise<void> {
        this.closeCalls++;
        if (this.closeError) {
            const e = this.closeError;
            this.closeError = null;
            throw e;
        }
        this.closed = true;
    }
}
