/**
 * MCP tool adapter — map an MCP tool definition to a sidecar TacoTool.
 *
 * The MCP inputSchema is a raw JSON Schema and is passed through directly as
 * `parameters`: Anthropic's provider reads only `schema.properties` /
 * `schema.required`, and typebox Value.Check works on plain JSON Schema, so no
 * conversion library is needed. The type-level cast keeps the TSchema contract.
 *
 * Error convention (mirrors shell.ts): an MCP `isError` result or a thrown
 * callTool becomes a text result the model can read — never a throw — so one
 * broken MCP server cannot interrupt the turn. The exception is caller
 * abort (signal aborted), which re-throws so the harness can stop the batch.
 */

import type {
    AgentHarnessTool,
    AgentToolResult,
    ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { McpCallResult, McpClientHandle, McpToolInfo } from "./mcpClient.ts";

export interface McpToolAdapterOptions {
    /** Provider tool name, already sanitized + deduped. */
    name: string;
    serverId: string;
    rawName: string;
    handle: McpClientHandle;
    info: McpToolInfo;
}

const EMPTY_SCHEMA = { type: "object" as const, properties: {} };

/** Map MCP result content to pi TextContent. Non-text blocks become placeholders. */
export function mapMcpContent(content: readonly unknown[]): TextContent[] {
    const out: TextContent[] = [];
    for (const block of content) {
        if (block && typeof block === "object") {
            const b = block as { type?: unknown; text?: unknown };
            if (b.type === "text" && typeof b.text === "string") {
                out.push({ type: "text", text: b.text });
                continue;
            }
            if (b.type === "image") {
                out.push({ type: "text", text: "[mcp image content — not forwarded]" });
                continue;
            }
            if (b.type === "audio") {
                out.push({ type: "text", text: "[mcp audio content — not forwarded]" });
                continue;
            }
            if (b.type === "resource" || b.type === "resource_link") {
                out.push({ type: "text", text: "[mcp resource content — not forwarded]" });
                continue;
            }
        }
        out.push({ type: "text", text: "[mcp content block omitted]" });
    }
    return out;
}

function extractSchema(inputSchema: unknown): { type: "object"; properties: unknown } {
    if (
        inputSchema &&
        typeof inputSchema === "object" &&
        (inputSchema as { type?: unknown }).type === "object"
    ) {
        return inputSchema as { type: "object"; properties: unknown };
    }
    return EMPTY_SCHEMA;
}

/** Structured details returned by an MCP tool execution. */
export interface McpToolExecDetails {
    isError: boolean;
    error?: string;
}

/** Construct a TacoTool that proxies to an MCP tool. */
export function createMcpToolAdapter(
    opts: McpToolAdapterOptions,
): AgentHarnessTool<ExecutionToolContext, TSchema, McpToolExecDetails> {
    const { name, serverId, rawName, handle, info } = opts;
    const schema = extractSchema(info.inputSchema);
    const description =
        info.description ??
        `MCP tool ${rawName} from server ${serverId}. Execute it by passing arguments matching its schema.`;

    return {
        name,
        label: name,
        description,
        parameters: schema as unknown as TSchema,
        executionMode: "sequential",
        async execute(
            _toolCallId: string,
            params: unknown,
            signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            _context: ExecutionToolContext,
        ): Promise<AgentToolResult<McpToolExecDetails>> {
            if (signal?.aborted) throw new Error("Operation aborted");
            let result: McpCallResult;
            try {
                result = await handle.callTool(rawName, params, signal);
            } catch (err) {
                // Caller abort must propagate so the harness stops the batch;
                // any other failure is returned as a readable result.
                if (signal?.aborted) throw err;
                return {
                    content: [
                        {
                            type: "text",
                            text: `[mcp ${serverId} ${rawName} failed] ${messageOf(err)}`,
                        },
                    ],
                    details: { isError: true, error: messageOf(err) },
                };
            }
            return {
                content: mapMcpContent(result.content),
                details: { isError: result.isError === true },
            };
        },
    };
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
