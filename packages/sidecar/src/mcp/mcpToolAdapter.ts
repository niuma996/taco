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

import { IMAGE_INPUT_MAX_BASE64_LENGTH } from "@taco-ai/protocol";
import type { TSchema } from "typebox";
import { isModelImageMime, sniffImageMime } from "../attachments/mimeType.ts";
import type {
    AgentHarnessTool,
    AgentToolResult,
    Context,
    ExecutionToolContext,
    ImageContent,
    TextContent,
} from "../runtime/pi/types.ts";
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

/** How many images one MCP result may carry into the conversation. */
const MAX_MCP_IMAGES = 5;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Standard base64, or undefined when the payload is not base64.
 *
 * MCP servers wrap the payload and sometimes send the URL-safe alphabet.
 * The image block carries the standard form, so a later decode does not
 * have to guess.
 */
function normalizeBase64(data: string): string | undefined {
    const stripped = data.replace(/\s+/g, "");
    if (stripped.length === 0 || stripped.length > IMAGE_INPUT_MAX_BASE64_LENGTH) return undefined;
    if (BASE64_PATTERN.test(stripped)) return stripped;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(stripped)) return undefined;
    const standard = stripped.replace(/-/g, "+").replace(/_/g, "/");
    const pad = standard.length % 4 === 0 ? "" : "=".repeat(4 - (standard.length % 4));
    const padded = standard + pad;
    if (padded.length > IMAGE_INPUT_MAX_BASE64_LENGTH || !BASE64_PATTERN.test(padded)) {
        return undefined;
    }
    return padded;
}

/**
 * True when a PNG carries an `acTL` chunk before `IDAT`.
 *
 * Providers reject animated PNGs, and pi's read tool refuses them. The
 * attachment sniff reads 16 bytes and cannot see the chunk, so the check
 * walks this buffer only — storage still calls an animated PNG an image.
 */
function isAnimatedPng(bytes: Buffer): boolean {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
        return false;
    }
    let offset = signature.length;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset) >>> 0;
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (type === "acTL") return true;
        if (type === "IDAT") return false;
        const next = offset + 12 + length;
        if (next <= offset || next > bytes.length) return false;
        offset = next;
    }
    return false;
}

/**
 * An MCP image block as a pi image block, when its bytes are a raster a
 * provider accepts. The bytes decide, not the declared mime. Whitespace and
 * base64url are normalised first. An animated PNG is refused. A model
 * without image input is handled by pi, which replaces the block before the
 * request leaves.
 */
function toImageContent(data: unknown): ImageContent | undefined {
    if (typeof data !== "string") return undefined;
    const normalized = normalizeBase64(data);
    if (!normalized) return undefined;
    const bytes = Buffer.from(normalized, "base64");
    const sniffed = sniffImageMime(bytes);
    if (!sniffed || !isModelImageMime(sniffed)) return undefined;
    if (sniffed === "image/png" && isAnimatedPng(bytes)) return undefined;
    return { type: "image", data: normalized, mimeType: sniffed };
}

/**
 * Map MCP result content to pi content. Images become image blocks when they
 * carry bytes a provider accepts; every other block becomes text.
 */
export function mapMcpContent(content: readonly unknown[]): (TextContent | ImageContent)[] {
    const out: (TextContent | ImageContent)[] = [];
    let images = 0;
    for (const block of content) {
        if (block && typeof block === "object") {
            const b = block as { type?: unknown; text?: unknown; data?: unknown };
            if (b.type === "text" && typeof b.text === "string") {
                out.push({ type: "text", text: b.text });
                continue;
            }
            if (b.type === "image") {
                const image = toImageContent(b.data);
                if (image && images < MAX_MCP_IMAGES) {
                    out.push(image);
                    images++;
                    continue;
                }
                out.push({ type: "text", text: "[mcp image content — not forwarded]" });
                continue;
            }
            if (b.type === "audio") {
                out.push({ type: "text", text: "[mcp audio content — not forwarded]" });
                continue;
            }
            if (b.type === "resource" || b.type === "resource_link") {
                const blob = (block as { resource?: { blob?: unknown } }).resource?.blob;
                const image = toImageContent(blob);
                if (image && images < MAX_MCP_IMAGES) {
                    out.push(image);
                    images++;
                    continue;
                }
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
            _onUpdate: unknown,
            _toolContext: ExecutionToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<AgentToolResult<McpToolExecDetails>> {
            // pi 0.85 carries cancellation on the Context rather than a
            // dedicated parameter.
            const signal = piContext.abortSignal;
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
