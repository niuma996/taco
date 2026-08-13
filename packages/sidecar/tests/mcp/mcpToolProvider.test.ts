/**
 * mcpToolProvider — multi-server discovery, failure isolation, and dispose.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { McpServerConfig } from "@taco-ai/protocol";
import type { Logger } from "../../src/lib/logger.ts";
import type { McpClientFactory, McpClientHandle } from "../../src/mcp/mcpClient.ts";
import { discoverMcpTools } from "../../src/mcp/mcpToolProvider.ts";
import { FakeMcpClient } from "../_helpers/fakeMcpClient.ts";

const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const server = (id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
    id,
    transport: "stdio",
    command: "echo",
    ...overrides,
});

function factoryFrom(
    handles: Map<string, McpClientHandle>,
    failOn?: (id: string) => boolean,
): McpClientFactory {
    return async (cfg) => {
        if (failOn?.(cfg.id)) throw new Error(`boom ${cfg.id}`);
        const h = handles.get(cfg.id);
        if (!h) throw new Error(`no handle for ${cfg.id}`);
        return h;
    };
}

describe("discoverMcpTools", () => {
    it("produces one candidate per discovered tool, namespaced mcp__<id>__<tool>", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "gh",
                new FakeMcpClient("gh", [
                    { name: "list_issues", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
            [
                "db",
                new FakeMcpClient("db", [
                    { name: "query", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const provider = await discoverMcpTools({
            servers: [server("gh"), server("db")],
            clientFactory: factoryFrom(handles),
            log: silentLogger as unknown as Logger,
        });
        const names = provider
            .candidates()
            .map((c) => c.name)
            .sort();
        assert.deepEqual(names, ["mcp__db__query", "mcp__gh__list_issues"]);
        assert.equal(
            provider.candidates().every((c) => c.source === "mcp"),
            true,
        );
    });

    it("marks alwaysLoaded raw names as loading always, rest deferred", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "gh",
                new FakeMcpClient("gh", [
                    { name: "list_issues", inputSchema: { type: "object", properties: {} } },
                    { name: "merge_pr", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const provider = await discoverMcpTools({
            servers: [server("gh", { alwaysLoaded: ["merge_pr"] })],
            clientFactory: factoryFrom(handles),
            log: silentLogger as unknown as Logger,
        });
        const byName = new Map(provider.candidates().map((c) => [c.name, c]));
        assert.equal(byName.get("mcp__gh__merge_pr")?.loading, "always");
        assert.equal(byName.get("mcp__gh__list_issues")?.loading, "deferred");
    });

    it("dedupes colliding provider names across servers", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "a",
                new FakeMcpClient("a", [
                    { name: "tool", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
            [
                "b",
                new FakeMcpClient("b", [
                    { name: "tool", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const provider = await discoverMcpTools({
            servers: [server("a"), server("b")],
            clientFactory: factoryFrom(handles),
            log: silentLogger as unknown as Logger,
        });
        const names = provider
            .candidates()
            .map((c) => c.name)
            .sort();
        // mcp__a__tool and mcp__b__tool are distinct prefixes — no collision.
        assert.deepEqual(names, ["mcp__a__tool", "mcp__b__tool"]);
    });

    it("dedupes when sanitization collides two raw names within one server", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "s",
                new FakeMcpClient("s", [
                    { name: "my tool", inputSchema: { type: "object", properties: {} } },
                    { name: "my_tool", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const provider = await discoverMcpTools({
            servers: [server("s")],
            clientFactory: factoryFrom(handles),
            log: silentLogger as unknown as Logger,
        });
        const names = provider
            .candidates()
            .map((c) => c.name)
            .sort();
        assert.deepEqual(names, ["mcp__s__my_tool", "mcp__s__my_tool_2"]);
    });

    it("isolates a failing server: contributes zero candidates, warns, does not throw", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "ok",
                new FakeMcpClient("ok", [
                    { name: "fine", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const warnings: string[] = [];
        const log = { ...silentLogger, warn: (m: string) => warnings.push(m) };
        const provider = await discoverMcpTools({
            servers: [server("ok"), server("bad")],
            clientFactory: factoryFrom(handles, (id) => id === "bad"),
            log: log as unknown as Logger,
        });
        assert.deepEqual(
            provider.candidates().map((c) => c.name),
            ["mcp__ok__fine"],
        );
        assert.equal(
            warnings.some((w) => w.includes("bad") && w.includes("discovery failed")),
            true,
        );
    });

    it("closes the handle when listTools throws after a successful connect", async () => {
        // listTools can throw long after the stdio child / HTTP socket is
        // already alive — the handle we returned from factory() must not leak.
        const flaky = new FakeMcpClient("flaky", []);
        flaky.listTools = async () => {
            throw new Error("listTools exploded");
        };
        const warnings: string[] = [];
        const log = { ...silentLogger, warn: (m: string) => warnings.push(m) };
        const provider = await discoverMcpTools({
            servers: [server("flaky")],
            clientFactory: factoryFrom(new Map([["flaky", flaky]])),
            log: log as unknown as Logger,
        });
        assert.deepEqual(provider.candidates(), []);
        assert.equal(flaky.closed, true, "handle must be closed on listTools failure");
        assert.equal(
            warnings.some((w) => w.includes("flaky") && w.includes("discovery failed")),
            true,
        );
        await provider.dispose(); // no-op, must not throw on already-closed handle
    });

    it("skips servers with enabled === false", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "on",
                new FakeMcpClient("on", [
                    { name: "t", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const provider = await discoverMcpTools({
            servers: [server("on"), server("off", { enabled: false })],
            clientFactory: factoryFrom(handles, (id) => id === "off"),
            log: silentLogger as unknown as Logger,
        });
        // "off" is not even attempted — its factory would throw, so no warning path.
        assert.deepEqual(
            provider.candidates().map((c) => c.name),
            ["mcp__on__t"],
        );
    });

    it("dispose closes every discovered client", async () => {
        const a = new FakeMcpClient("a", [
            { name: "t1", inputSchema: { type: "object", properties: {} } },
        ]);
        const b = new FakeMcpClient("b", [
            { name: "t2", inputSchema: { type: "object", properties: {} } },
        ]);
        const provider = await discoverMcpTools({
            servers: [server("a"), server("b")],
            clientFactory: factoryFrom(
                new Map([
                    ["a", a],
                    ["b", b],
                ]),
            ),
            log: silentLogger as unknown as Logger,
        });
        assert.equal(a.closed, false);
        assert.equal(b.closed, false);
        await provider.dispose();
        assert.equal(a.closed, true);
        assert.equal(b.closed, true);
    });

    it("load() returns an executable tool proxying to the live handle", async () => {
        const handle = new FakeMcpClient(
            "gh",
            [{ name: "list_issues", inputSchema: { type: "object", properties: {} } }],
            async () => ({
                content: [{ type: "text", text: "issue #1" }],
            }),
        );
        const provider = await discoverMcpTools({
            servers: [server("gh")],
            clientFactory: factoryFrom(new Map([["gh", handle]])),
            log: silentLogger as unknown as Logger,
        });
        const [candidate] = provider.candidates();
        const tool = await candidate.load();
        const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
        assert.equal((result.content[0] as { text: string }).text, "issue #1");
        assert.equal((result.details as { isError: boolean }).isError, false);
        assert.deepEqual(
            handle.calls.map((c) => c.name),
            ["list_issues"],
        );
    });
});
