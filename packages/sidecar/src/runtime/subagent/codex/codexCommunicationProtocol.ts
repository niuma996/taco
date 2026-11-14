import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type BridgeRequest =
    | { type: "hello"; token: string }
    | { type: "call"; id: string; name: string; arguments: unknown }
    | { type: "cancel"; id: string };

export type BridgeResponse =
    | { type: "ready"; tools: Tool[] }
    | { type: "response"; id: string; ok: true; result: unknown }
    | { type: "response"; id: string; ok: false; error: string; code?: number };
