import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const chatSchema = Type.Object(
    {
        subSessionId: Type.String(),
        prompt: Type.String(),
        delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
        background: Type.Optional(Type.Boolean()),
        inReplyTo: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export const listSchema = Type.Object({}, { additionalProperties: false });

/** Callbacks capture the caller's identity and workspace; tool arguments cannot override them. */
export interface ClaudeCodeCommunicationTools {
    readonly allowedNames?: readonly ("chatToAgent" | "listAgentSessions")[];
    chat(args: {
        subSessionId: string;
        prompt: string;
        delivery?: "steer" | "followUp";
        background?: boolean;
        inReplyTo?: string;
    }): Promise<unknown>;
    list(): Promise<unknown>;
}

export const communicationDefinitions = [
    {
        name: "chatToAgent",
        description:
            "Message an existing agent with the same parent, never yourself. " +
            "A queued or started receipt confirms acceptance, not completion; consult status and effectiveDelivery. " +
            "Claude Code uses nextTurn delivery; Codex queues in Taco until the current turn settles. " +
            "Claude Code does not interrupt an active tool; Codex also waits rather than interrupting. " +
            "Agents have independent context; later parent conversation messages are not synced, so send needed context explicitly.",
        inputSchema: chatSchema,
    },
    {
        name: "listAgentSessions",
        description:
            "List other existing agent instances with the same parent, never yourself, with status and delivery capability. " +
            "Use chatToAgent to send context explicitly. Claude Code uses nextTurn and does not interrupt an active tool; " +
            "Codex queues until the current turn settles.",
        inputSchema: listSchema,
    },
] as const;

function exposedCommunicationTools(host: ClaudeCodeCommunicationTools) {
    return communicationDefinitions.filter(
        (tool) => host.allowedNames === undefined || host.allowedNames.includes(tool.name),
    );
}

export function claudeCodeCommunicationAllowedTools(host: ClaudeCodeCommunicationTools): string[] {
    return exposedCommunicationTools(host).map((tool) => `mcp__taco__${tool.name}`);
}

/** An SDK transport server using existing MCP/TypeBox dependencies, with no network listener. */
export function createClaudeCodeCommunicationServer(host: ClaudeCodeCommunicationTools) {
    const instance = new McpServer({ name: "taco", version: "1" });
    // Freeze this run's profile grant; a caller cannot expand it by mutating allowedNames later.
    const tools = exposedCommunicationTools(host);
    // Raw MCP handlers accept JSON Schema directly, avoiding an undeclared Zod dependency.
    instance.server.registerCapabilities({ tools: {} });
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools,
    }));
    instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        if (!tools.some((tool) => tool.name === params.name)) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
        }
        const input = params.arguments ?? {};
        let invoke: () => Promise<unknown>;
        if (params.name === "chatToAgent") {
            if (!Value.Check(chatSchema, input)) {
                throw new McpError(ErrorCode.InvalidParams, "Invalid chatToAgent arguments");
            }
            invoke = () => host.chat(input);
        } else if (params.name === "listAgentSessions") {
            if (!Value.Check(listSchema, input)) {
                throw new McpError(ErrorCode.InvalidParams, "Invalid listAgentSessions arguments");
            }
            invoke = () => host.list();
        } else {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
        }
        try {
            const output = await invoke();
            return { content: [{ type: "text", text: JSON.stringify(output) ?? "null" }] };
        } catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: error instanceof Error ? error.message : String(error) },
                ],
            };
        }
    });
    return { type: "sdk", name: "taco", instance } as const;
}
