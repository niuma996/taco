import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { asSessionId } from "@taco-ai/protocol";
import {
    type RunClaudeCodeSubagentArgs,
    runClaudeCodeSubagent,
} from "../../src/runtime/subagent/claudeCode/claudeCodeRunner.ts";
import type {
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";

async function withBridge(
    inspect: (client: Client, options: SdkQueryOptions) => Promise<void>,
    communicationTools: NonNullable<RunClaudeCodeSubagentArgs["communicationTools"]> = {
        chat: async () => ({ delivered: true }),
        list: async () => ["child-2"],
    },
) {
    const response = await runClaudeCodeSubagent({
        subSessionId: asSessionId("child-1"),
        agentType: "cc",
        prompt: "coordinate",
        tools: ["Read"],
        cwd: "/work",
        abortController: new AbortController(),
        communicationTools,
        appendMessages: async () => {},
        findExecutable: () => "/usr/local/bin/claude",
        loadSdk: async () => ({
            query: async function* ({ options }): AsyncIterable<SdkMessage> {
                assert.equal(options.strictMcpConfig, true);
                assert.deepEqual(Object.keys(options.mcpServers), ["taco"]);
                const config = options.mcpServers.taco;
                assert.ok(config);
                assert.equal(config.type, "sdk");
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                const client = new Client({ name: "adapter-test", version: "1" });
                await config.instance.connect(serverTransport);
                await client.connect(clientTransport);
                try {
                    await inspect(client, options);
                } finally {
                    await client.close();
                }
                yield {
                    type: "assistant",
                    message: { id: "a", content: [{ type: "text", text: "done" }] },
                };
                yield { type: "result", subtype: "success", is_error: false, num_turns: 1 };
            },
        }),
    });
    assert.equal(response.isError, false, response.resultText);
}

it("exposes only two host-bound tools and grants only those MCP tool permissions", async () => {
    const calls: unknown[] = [];
    const input = {
        subSessionId: "child-2",
        prompt: "update",
        delivery: "steer",
        background: true,
        inReplyTo: "message-1",
    };
    await withBridge(
        async (client, options) => {
            assert.deepEqual(options.tools, ["Read"]);
            assert.deepEqual(options.allowedTools, [
                "mcp__taco__chatToAgent",
                "mcp__taco__listAgentSessions",
            ]);
            const { tools } = await client.listTools();
            assert.deepEqual(
                tools.map((tool) => tool.name),
                ["chatToAgent", "listAgentSessions"],
            );
            assert.deepEqual(tools[0]?.inputSchema.required, ["subSessionId", "prompt"]);
            assert.equal(tools[0]?.inputSchema.additionalProperties, false);
            const sent = await client.callTool({ name: "chatToAgent", arguments: input });
            assert.deepEqual(sent.content, [{ type: "text", text: '{"delivered":true}' }]);
            const listed = await client.callTool({ name: "listAgentSessions", arguments: {} });
            assert.deepEqual(listed.content, [{ type: "text", text: '["child-2"]' }]);
            await client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child-2", prompt: "follow", delivery: "followUp" },
            });
        },
        {
            chat: async (value) => {
                calls.push(value);
                return { delivered: true };
            },
            list: async () => {
                calls.push("list");
                return ["child-2"];
            },
        },
    );
    assert.deepEqual(calls, [
        input,
        "list",
        { subSessionId: "child-2", prompt: "follow", delivery: "followUp" },
    ]);
});

it("rejects unknown tools, forged host context, and invalid arguments without invoking callbacks", async () => {
    let calls = 0;
    await withBridge(
        async (client) => {
            for (const request of [
                { name: "shell", arguments: { command: "whoami" } },
                { name: "chatToAgent", arguments: { subSessionId: "child-2" } },
                {
                    name: "chatToAgent",
                    arguments: { subSessionId: "child-2", prompt: "x", callerSessionId: "forged" },
                },
                {
                    name: "chatToAgent",
                    arguments: { subSessionId: "child-2", prompt: "x", delivery: "anything" },
                },
                {
                    name: "chatToAgent",
                    arguments: { subSessionId: "child-2", prompt: "x", background: "yes" },
                },
                { name: "listAgentSessions", arguments: { workspace: "forged" } },
            ]) {
                await assert.rejects(client.callTool(request), /Unknown tool|Invalid.*arguments/);
            }
        },
        {
            chat: async () => {
                calls++;
            },
            list: async () => {
                calls++;
            },
        },
    );
    assert.equal(calls, 0);
});

it("reports host callback failures as MCP tool errors", async () => {
    await withBridge(
        async (client) => {
            const failed = await client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child-2", prompt: "x" },
            });
            assert.equal(failed.isError, true);
            assert.deepEqual(failed.content, [{ type: "text", text: "host unavailable" }]);
            const listed = await client.callTool({ name: "listAgentSessions", arguments: {} });
            assert.equal(listed.isError, true);
        },
        {
            chat: async () => {
                throw new Error("host unavailable");
            },
            list: async () => {
                throw new Error("host unavailable");
            },
        },
    );
});

for (const allowedNames of [
    [],
    ["chatToAgent"],
    ["listAgentSessions"],
    ["listAgentSessions", "chatToAgent", "chatToAgent"],
] as const) {
    it(`limits listing, dispatch, and SDK grants to ${JSON.stringify(allowedNames)}`, async () => {
        const called: string[] = [];
        await withBridge(
            async (client, options) => {
                const names = ["chatToAgent", "listAgentSessions"].filter((name) =>
                    allowedNames.some((allowed) => allowed === name),
                );
                assert.deepEqual(
                    (await client.listTools()).tools.map((tool) => tool.name),
                    names,
                );
                assert.deepEqual(
                    options.allowedTools,
                    names.map((name) => `mcp__taco__${name}`),
                );
                for (const request of [
                    { name: "chatToAgent", arguments: { subSessionId: "peer", prompt: "hello" } },
                    { name: "listAgentSessions", arguments: {} },
                ]) {
                    if (names.includes(request.name)) await client.callTool(request);
                    else await assert.rejects(client.callTool(request), /Unknown tool/);
                }
                assert.deepEqual(called, names);
            },
            {
                allowedNames,
                chat: async () => {
                    called.push("chatToAgent");
                },
                list: async () => {
                    called.push("listAgentSessions");
                },
            },
        );
    });
}

it("keeps the declared tools fixed for the run even if the host mutates its array", async () => {
    const allowedNames: ("chatToAgent" | "listAgentSessions")[] = ["chatToAgent"];
    await withBridge(
        async (client, options) => {
            allowedNames.push("listAgentSessions");
            assert.deepEqual(options.allowedTools, ["mcp__taco__chatToAgent"]);
            assert.deepEqual(
                (await client.listTools()).tools.map((tool) => tool.name),
                ["chatToAgent"],
            );
            await assert.rejects(client.callTool({ name: "listAgentSessions" }), /Unknown tool/);
        },
        { allowedNames, chat: async () => {}, list: async () => {} },
    );
});

it("describes peer boundaries, receipt semantics, delivery timing, and independent context", async () => {
    await withBridge(async (client) => {
        const { tools } = await client.listTools();
        const chat = tools.find((tool) => tool.name === "chatToAgent")?.description ?? "";
        const list = tools.find((tool) => tool.name === "listAgentSessions")?.description ?? "";
        for (const description of [chat, list]) {
            assert.match(description, /same parent/);
            assert.match(description, /never yourself/);
            assert.match(description, /nextTurn/);
            assert.match(description, /does not interrupt an active tool/);
        }
        assert.match(chat, /receipt.*not completion/);
        assert.match(chat, /independent context/);
        assert.match(chat, /parent conversation.*send.*explicitly/);
    });
});
