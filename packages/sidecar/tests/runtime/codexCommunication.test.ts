import assert from "node:assert/strict";
import { it } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    type CodexCommunicationTools,
    createCodexCommunicationBridge,
} from "../../src/runtime/subagent/codex/codexCommunication.ts";

async function withBridge(
    host: CodexCommunicationTools,
    inspect: (client: Client) => Promise<void>,
): Promise<void> {
    const bridge = await createCodexCommunicationBridge(host);
    const transport = new StdioClientTransport({
        ...bridge.mcpServer,
        stderr: "pipe",
    });
    const client = new Client({ name: "codex-bridge-test", version: "1" });
    try {
        await client.connect(transport);
        await inspect(client);
    } finally {
        await client.close();
        await bridge.close();
    }
}

it("exposes only the granted host-bound communication tools", async () => {
    const calls: unknown[] = [];
    await withBridge(
        {
            allowedNames: ["chatToAgent", "listAgentSessions"],
            chat: async (input) => {
                calls.push(input);
                return { delivered: true };
            },
            list: async () => {
                calls.push("list");
                return ["child-2"];
            },
        },
        async (client) => {
            const { tools } = await client.listTools();
            assert.deepEqual(
                tools.map((tool) => tool.name),
                ["chatToAgent", "listAgentSessions"],
            );
            const chat = await client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child-2", prompt: "hello" },
            });
            assert.deepEqual(chat.content, [
                { type: "text", text: JSON.stringify({ delivered: true }) },
            ]);
            const listed = await client.callTool({ name: "listAgentSessions", arguments: {} });
            assert.deepEqual(listed.content, [{ type: "text", text: '["child-2"]' }]);
        },
    );
    assert.deepEqual(calls, [{ subSessionId: "child-2", prompt: "hello" }, "list"]);
});

it("rejects unknown tools, forged arguments, and ungranted tools", async () => {
    let calls = 0;
    await withBridge(
        {
            allowedNames: ["chatToAgent"],
            chat: async () => {
                calls++;
            },
            list: async () => {
                calls++;
            },
        },
        async (client) => {
            assert.deepEqual(
                (await client.listTools()).tools.map((tool) => tool.name),
                ["chatToAgent"],
            );
            await assert.rejects(
                client.callTool({ name: "shell", arguments: { command: "whoami" } }),
            );
            await assert.rejects(
                client.callTool({
                    name: "chatToAgent",
                    arguments: { subSessionId: "child-2", prompt: "x", callerSessionId: "forged" },
                }),
            );
            await assert.rejects(client.callTool({ name: "listAgentSessions", arguments: {} }));
        },
    );
    assert.equal(calls, 0);
});

it("reports host callback failures as tool errors", async () => {
    await withBridge(
        {
            allowedNames: ["chatToAgent"],
            chat: async () => {
                throw new Error("host unavailable");
            },
            list: async () => [],
        },
        async (client) => {
            const failed = await client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child-2", prompt: "x" },
            });
            assert.equal(failed.isError, true);
            assert.deepEqual(failed.content, [{ type: "text", text: "host unavailable" }]);
        },
    );
});

it("survives a client disconnect during an in-flight host call", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
        release = resolve;
    });
    const bridge = await createCodexCommunicationBridge({
        allowedNames: ["chatToAgent"],
        chat: async () => pending,
        list: async () => [],
    });
    const transport = new StdioClientTransport({
        ...bridge.mcpServer,
        stderr: "pipe",
    });
    const client = new Client({ name: "codex-bridge-disconnect", version: "1" });
    try {
        await client.connect(transport);
        const call = client
            .callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child-2", prompt: "x" },
            })
            .catch(() => undefined);
        await nextImmediate();
        await client.close();
        release({ delivered: true });
        await call;
    } finally {
        await bridge.close();
    }
});
