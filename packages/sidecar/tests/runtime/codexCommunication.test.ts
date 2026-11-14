import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, LATEST_PROTOCOL_VERSION, McpError } from "@modelcontextprotocol/sdk/types.js";
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
                (error: unknown) =>
                    error instanceof McpError && error.code === ErrorCode.MethodNotFound,
            );
            await assert.rejects(
                client.callTool({
                    name: "chatToAgent",
                    arguments: { subSessionId: "child-2", prompt: "x", callerSessionId: "forged" },
                }),
                (error: unknown) =>
                    error instanceof McpError && error.code === ErrorCode.InvalidParams,
            );
            await assert.rejects(
                client.callTool({ name: "listAgentSessions", arguments: {} }),
                (error: unknown) =>
                    error instanceof McpError && error.code === ErrorCode.MethodNotFound,
            );
            await assert.rejects(
                client.callTool({
                    name: "chatToAgent",
                    arguments: { subSessionId: 1, prompt: "x" },
                }),
                (error: unknown) =>
                    error instanceof McpError && error.code === ErrorCode.InvalidParams,
            );
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

it("launches a standalone TypeScript entry with explicit native transformation", async () => {
    const bridge = await createCodexCommunicationBridge({
        chat: async () => null,
        list: async () => [],
    });
    try {
        assert.ok(bridge.mcpServer.args.includes("--disable-warning=ExperimentalWarning"));
        assert.ok(bridge.mcpServer.args.includes("--experimental-transform-types"));
        assert.ok(bridge.mcpServer.args.at(-1)?.endsWith("codexCommunicationBridge.ts"));
    } finally {
        await bridge.close();
    }
});

it("source bridge startup keeps stderr free of experimental warnings", async () => {
    const bridge = await createCodexCommunicationBridge({
        chat: async () => null,
        list: async () => [],
    });
    const transport = new StdioClientTransport({ ...bridge.mcpServer, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
        stderr += chunk;
    });
    const client = new Client({ name: "quiet-source-bridge", version: "1" });
    try {
        await client.connect(transport);
        await client.listTools();
    } finally {
        await client.close();
        await bridge.close();
    }
    assert.doesNotMatch(stderr, /ExperimentalWarning|Transform Types is an experimental feature/);
});

it("negotiates an unsupported protocol version using the SDK instead of echoing it", async () => {
    const bridge = await createCodexCommunicationBridge({
        chat: async () => null,
        list: async () => [],
    });
    const child = spawn(bridge.mcpServer.command, bridge.mcpServer.args, {
        env: bridge.mcpServer.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    try {
        const response = once(lines, "line");
        child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: {
                    protocolVersion: "unsupported-test-version",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }) + "\n",
        );
        const [line] = await response;
        const message = JSON.parse(line);
        assert.equal(message.id, "init");
        assert.equal(message.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    } finally {
        child.kill();
        lines.close();
        await bridge.close();
    }
});

it("propagates cancellation to the host and allows a subsequent call", async () => {
    let called!: () => void;
    const started = new Promise<void>((resolve) => {
        called = resolve;
    });
    let hostSignal: AbortSignal | undefined;
    await withBridge(
        {
            chat: async (_input, signal) => {
                hostSignal = signal;
                called();
                return new Promise(() => {});
            },
            list: async () => ["still-connected"],
        },
        async (client) => {
            const abort = new AbortController();
            const result = client.callTool(
                { name: "chatToAgent", arguments: { subSessionId: "child", prompt: "wait" } },
                undefined,
                { signal: abort.signal },
            );
            const rejected = assert.rejects(result, /cancel/i);
            await started;
            abort.abort(new Error("cancel test"));
            await rejected;
            // The list response is a round-trip barrier after the cancellation notification.
            const listed = await client.callTool({ name: "listAgentSessions", arguments: {} });
            assert.deepEqual(listed.content, [{ type: "text", text: '["still-connected"]' }]);
            assert.equal(hostSignal?.aborted, true);
        },
    );
});

it("freezes each run's grants and captured callbacks", async () => {
    const allowedNames: ("chatToAgent" | "listAgentSessions")[] = ["chatToAgent"];
    const host = { allowedNames, chat: async () => "original-identity", list: async () => [] };
    await withBridge(host, async (client) => {
        allowedNames.push("listAgentSessions");
        host.chat = async () => "replacement-identity";
        assert.deepEqual(
            (await client.listTools()).tools.map((tool) => tool.name),
            ["chatToAgent"],
        );
        await assert.rejects(client.callTool({ name: "listAgentSessions", arguments: {} }));
        const result = await client.callTool({
            name: "chatToAgent",
            arguments: { subSessionId: "child", prompt: "hello" },
        });
        assert.deepEqual(result.content, [{ type: "text", text: '"original-identity"' }]);
    });
});

it("correlates concurrent calls when the host responds out of order", async () => {
    const releases = new Map<string, (value: unknown) => void>();
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        bothStarted = resolve;
    });
    await withBridge(
        {
            chat: async ({ prompt }) =>
                new Promise((resolve) => {
                    releases.set(prompt, resolve);
                    if (releases.size === 2) bothStarted();
                }),
            list: async () => [],
        },
        async (client) => {
            const first = client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child", prompt: "first" },
            });
            const second = client.callTool({
                name: "chatToAgent",
                arguments: { subSessionId: "child", prompt: "second" },
            });
            await started;
            releases.get("second")?.("second-result");
            assert.deepEqual((await second).content, [{ type: "text", text: '"second-result"' }]);
            releases.get("first")?.("first-result");
            assert.deepEqual((await first).content, [{ type: "text", text: '"first-result"' }]);
        },
    );
});

it("rejects unauthenticated socket clients before invoking host tools", async () => {
    let calls = 0;
    const bridge = await createCodexCommunicationBridge({
        chat: async () => {
            calls++;
        },
        list: async () => [],
    });
    try {
        for (const message of [
            { type: "hello", token: "incorrect" },
            { type: "call", id: "forged", name: "chatToAgent", arguments: {} },
            null,
        ]) {
            const socket = connect(bridge.mcpServer.env.TACO_CODEX_BRIDGE_SOCKET);
            let data = "";
            socket.on("data", (chunk) => {
                data += chunk;
            });
            const closed = once(socket, "close");
            await once(socket, "connect");
            socket.write(JSON.stringify(message) + "\n");
            await closed;
            assert.equal(data, "");
        }
        assert.equal(calls, 0);
    } finally {
        await bridge.close();
    }
});

it("exits after host socket closure while client stdin remains open", {
    timeout: 5000,
}, async () => {
    const bridge = await createCodexCommunicationBridge({
        chat: async () => null,
        list: async () => [],
    });
    const child = spawn(bridge.mcpServer.command, bridge.mcpServer.args, {
        env: bridge.mcpServer.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    try {
        const initialized = once(lines, "line");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
        await initialized;
        const exited = once(child, "exit");
        await bridge.close();
        const [code, signal] = await exited;
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.equal(child.stdin.writableEnded, false);
    } finally {
        child.kill();
        lines.close();
        await bridge.close();
    }
});

it("exits and aborts in-flight host work when subprocess stdin ends", {
    timeout: 5000,
}, async () => {
    let called!: () => void;
    const started = new Promise<void>((resolve) => {
        called = resolve;
    });
    let hostSignal: AbortSignal | undefined;
    const bridge = await createCodexCommunicationBridge({
        chat: async (_input, signal) => {
            hostSignal = signal;
            called();
            return new Promise(() => {});
        },
        list: async () => [],
    });
    const child = spawn(bridge.mcpServer.command, bridge.mcpServer.args, {
        env: bridge.mcpServer.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    try {
        child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                method: "tools/call",
                params: {
                    name: "chatToAgent",
                    arguments: { subSessionId: "child", prompt: "wait" },
                },
            }) + "\n",
        );
        await started;
        const exited = once(child, "exit");
        child.stdin.end();
        assert.deepEqual(await exited, [0, null]);
        // A socket close is observed by the host on the following turn.
        await nextImmediate();
        assert.equal(hostSignal?.aborted, true);
    } finally {
        child.kill();
        await bridge.close();
    }
});

it("reports missing bridge environment with exit code 2", async () => {
    const child = spawn(
        process.execPath,
        [
            "--experimental-transform-types",
            new URL("../../src/runtime/subagent/codex/codexCommunicationBridge.ts", import.meta.url)
                .pathname,
        ],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const [code, signal] = await once(child, "close");
    assert.equal(code, 2);
    assert.equal(signal, null);
    assert.match(stderr, /missing Codex bridge environment/);
});

it("starts the entry through a symlink path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-bridge-link-"));
    try {
        const link = join(dir, "source");
        symlinkSync(
            fileURLToPath(new URL("../../src/runtime/subagent/codex", import.meta.url)),
            link,
            process.platform === "win32" ? "junction" : "dir",
        );
        const child = spawn(
            process.execPath,
            ["--experimental-transform-types", join(link, "codexCommunicationBridge.ts")],
            { env: {}, stdio: ["pipe", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        assert.deepEqual(await once(child, "close"), [2, null]);
        assert.match(stderr, /missing Codex bridge environment/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it("imports the entry without starting the bridge", async () => {
    const entry = new URL(
        "../../src/runtime/subagent/codex/codexCommunicationBridge.ts",
        import.meta.url,
    ).href;
    const child = spawn(
        process.execPath,
        [
            "--experimental-transform-types",
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify(entry)});`,
        ],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    assert.deepEqual(await once(child, "close"), [0, null]);
    assert.doesNotMatch(stderr, /missing Codex bridge environment/);
});

it("exits and closes the host relay when the SDK transport rejects an oversized frame", {
    timeout: 5000,
}, async () => {
    let called!: () => void;
    const started = new Promise<void>((resolve) => {
        called = resolve;
    });
    let hostSignal: AbortSignal | undefined;
    const bridge = await createCodexCommunicationBridge({
        chat: async (_input, signal) => {
            hostSignal = signal;
            called();
            return new Promise(() => {});
        },
        list: async () => [],
    });
    const child = spawn(bridge.mcpServer.command, bridge.mcpServer.args, {
        env: bridge.mcpServer.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    try {
        child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "chatToAgent",
                    arguments: { subSessionId: "child", prompt: "wait" },
                },
            }) + "\n",
        );
        await started;
        const exited = once(child, "exit");
        // Exceed the SDK's 10 MiB read buffer without ending stdin.
        child.stdin.write(Buffer.alloc(11 * 1024 * 1024, 0x61));
        assert.deepEqual(await exited, [0, null]);
        assert.equal(hostSignal?.aborted, true);
    } finally {
        child.kill();
        await bridge.close();
    }
});
