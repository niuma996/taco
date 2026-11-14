import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";

import {
    type AgentCommunicationTools as ClaudeCodeCommunicationTools,
    chatSchema,
    communicationDefinitions,
    listSchema,
} from "../agentCommunication.ts";

export type { AgentCommunicationTools as ClaudeCodeCommunicationTools } from "../agentCommunication.ts";

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
