/**
 * mcpToolAdapter — mapping MCP tool definitions and call results to sidecar tools.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { McpClientHandle, McpToolInfo } from "../../src/mcp/mcpClient.ts";
import { createMcpToolAdapter } from "../../src/mcp/mcpToolAdapter.ts";
import { FakeMcpClient } from "../_helpers/fakeMcpClient.ts";

const info = (overrides: Partial<McpToolInfo> = {}): McpToolInfo => ({
    name: "raw_tool",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    ...overrides,
});

function makeTool(
    opts: { handle?: McpClientHandle; info?: McpToolInfo } = {},
): ReturnType<typeof createMcpToolAdapter> {
    return createMcpToolAdapter({
        name: "mcp__svc__raw_tool",
        serverId: "svc",
        rawName: "raw_tool",
        handle: opts.handle ?? new FakeMcpClient("svc", []),
        info: opts.info ?? info(),
    });
}

const textOf = (c: { type: string; text?: string }): string => c.text ?? "";

describe("createMcpToolAdapter", () => {
    it("passes the MCP inputSchema through as parameters", () => {
        const tool = makeTool();
        const schema = tool.parameters as { properties?: unknown; required?: unknown };
        assert.deepEqual(schema.properties, { q: { type: "string" } });
        assert.deepEqual(schema.required, ["q"]);
        assert.equal(Value.Check(tool.parameters, { q: "hi" }), true);
        assert.equal(Value.Check(tool.parameters, {}), false);
    });

    it("degrades to an empty schema when inputSchema is missing or not an object", () => {
        const tool = makeTool({ info: info({ inputSchema: undefined }) });
        const schema = tool.parameters as { type: string; properties: unknown };
        assert.equal(schema.type, "object");
        assert.deepEqual(schema.properties, {});
        assert.equal(Value.Check(tool.parameters, { anything: 1 }), true);
    });

    it("maps text blocks to pi text content", async () => {
        const handle = new FakeMcpClient("svc", [], async () => ({
            content: [{ type: "text", text: "hello" }],
        }));
        const tool = makeTool({ handle });
        const result = await tool.execute("t1", { q: "hi" }, undefined, undefined, {} as never);
        assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
        assert.equal(result.details.isError, false);
        assert.deepEqual(
            handle.calls.map((c) => c.name),
            ["raw_tool"],
        );
    });

    it("degrades non-text blocks to placeholder text", async () => {
        const handle = new FakeMcpClient("svc", [], async () => ({
            content: [
                { type: "image", data: "x", mimeType: "image/png" },
                { type: "audio", data: "y", mimeType: "audio/wav" },
                { type: "resource", resource: { uri: "r", text: "z" } },
                { type: "weird", extra: true },
            ],
        }));
        const tool = makeTool({ handle });
        const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
        assert.equal(result.content.length, 4);
        for (const c of result.content) assert.equal(c.type, "text");
        assert.ok(textOf(result.content[0]).includes("image"));
        assert.ok(textOf(result.content[3]).includes("omitted"));
    });

    it("propagates MCP isError as details.isError", async () => {
        const handle = new FakeMcpClient("svc", [], async () => ({
            content: [{ type: "text", text: "boom" }],
            isError: true,
        }));
        const tool = makeTool({ handle });
        const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
        assert.equal(result.details.isError, true);
    });

    it("turns a thrown callTool into a readable error instead of bubbling", async () => {
        const handle = new FakeMcpClient("svc", [], async () => {
            throw new Error("connection lost");
        });
        const tool = makeTool({ handle });
        const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
        assert.equal(result.details.isError, true);
        assert.ok(textOf(result.content[0]).includes("connection lost"));
    });

    it("re-throws when the abort signal is already set before the call starts", async () => {
        const ac = new AbortController();
        ac.abort();
        const handle = new FakeMcpClient("svc", [], async () => ({
            content: [{ type: "text", text: "ok" }],
        }));
        const tool = makeTool({ handle });
        await assert.rejects(
            () => tool.execute("t1", {}, ac.signal, undefined, {} as never),
            /Operation aborted/,
        );
    });

    it("re-throws when the signal aborts mid-call, instead of returning a readable error", async () => {
        const ac = new AbortController();
        const handle = new FakeMcpClient("svc", [], async () => {
            // Simulate the abort landing while callTool is in flight: the signal
            // flips to aborted, then the SDK call rejects as a result.
            ac.abort();
            throw new Error("aborted mid-flight");
        });
        const tool = makeTool({ handle });
        await assert.rejects(
            () => tool.execute("t1", {}, ac.signal, undefined, {} as never),
            /aborted mid-flight/,
        );
    });

    it("uses the MCP description when present, else a synthesized one", () => {
        const described = makeTool({ info: info({ description: "finds things" }) });
        assert.ok(described.description.includes("finds things"));
        const bare = makeTool({ info: info({ description: undefined }) });
        assert.ok(bare.description.includes("raw_tool"));
        assert.ok(bare.description.includes("svc"));
    });
});
