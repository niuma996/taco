import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import type { Logger } from "../../src/lib/logger.ts";
import type { McpClientFactory, McpClientHandle, McpToolInfo } from "../../src/mcp/mcpClient.ts";
import { createMcpClient } from "../../src/mcp/mcpClient.ts";
import { createMcpToolAdapter } from "../../src/mcp/mcpToolAdapter.ts";
import { dedupeName, MAX_TOOL_NAME_LENGTH, mcpToolName } from "../../src/mcp/mcpToolName.ts";
import { discoverMcpTools } from "../../src/mcp/mcpToolProvider.ts";
import { FakeMcpClient } from "../_helpers/fakeMcpClient.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

describe("mcpToolName", () => {
    describe("mcpToolName", () => {
        it("prefixes with mcp__<serverId>__", () => {
            assert.equal(mcpToolName("github", "list_issues"), "mcp__github__list_issues");
        });

        it("replaces characters outside [a-zA-Z0-9_-] with underscores", () => {
            assert.equal(mcpToolName("svc", "my tool!"), "mcp__svc__my_tool_");
            assert.equal(mcpToolName("svc", "中文工具"), "mcp__svc______");
        });

        it("truncates the total to 128 chars", () => {
            const name = mcpToolName("svc", "t".repeat(200));
            assert.equal(name.length, MAX_TOOL_NAME_LENGTH);
            assert.ok(/^[a-zA-Z0-9_-]+$/.test(name));
        });

        it("keeps the prefix when truncating", () => {
            const name = mcpToolName("svc", "t".repeat(200));
            assert.ok(name.startsWith("mcp__svc__"));
        });
    });

    describe("dedupeName", () => {
        it("returns the name unchanged when free", () => {
            assert.equal(dedupeName("a", new Set(["b"])), "a");
        });

        it("appends _2 for the first collision", () => {
            assert.equal(dedupeName("a", new Set(["a"])), "a_2");
        });

        it("increments past taken suffixes", () => {
            assert.equal(dedupeName("a", new Set(["a", "a_2", "a_3"])), "a_4");
        });

        it("keeps the result within the provider 128-char limit", () => {
            const base = "m".repeat(128);
            const name = dedupeName(base, new Set([base]));
            assert.equal(name.length, MAX_TOOL_NAME_LENGTH);
            assert.ok(name.endsWith("_2"));
        });
    });
});

/** The PNG magic bytes, base64-encoded: enough for the MIME sniff. */
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe("mcpToolAdapter", () => {
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
            const result = await invokeTool(tool, { q: "hi" }, {} as never, { toolCallId: "t1" });
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
                    { type: "image", data: "not-base64!", mimeType: "image/png" },
                    { type: "audio", data: "y", mimeType: "audio/wav" },
                    { type: "resource", resource: { uri: "r", text: "z" } },
                    { type: "weird", extra: true },
                ],
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.equal(result.content.length, 4);
            for (const c of result.content) assert.equal(c.type, "text");
            assert.ok(textOf(result.content[0]).includes("image"));
            assert.ok(textOf(result.content[3]).includes("omitted"));
        });

        it("forwards an MCP image as an image block", async () => {
            const handle = new FakeMcpClient("svc", [], async () => ({
                content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.deepEqual(result.content, [
                { type: "image", data: PNG_BASE64, mimeType: "image/png" },
            ]);
        });

        it("forwards an image carried by an embedded resource", async () => {
            const handle = new FakeMcpClient("svc", [], async () => ({
                content: [
                    {
                        type: "resource",
                        resource: { uri: "u", mimeType: "image/png", blob: PNG_BASE64 },
                    },
                ],
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.deepEqual(result.content, [
                { type: "image", data: PNG_BASE64, mimeType: "image/png" },
            ]);
        });

        it("refuses an image whose bytes are not a raster format", async () => {
            const handle = new FakeMcpClient("svc", [], async () => ({
                content: [
                    {
                        type: "image",
                        data: Buffer.from("%PDF-1.7 pretend").toString("base64"),
                        mimeType: "image/png",
                    },
                ],
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.equal(result.content.length, 1);
            assert.equal(result.content[0].type, "text");
            assert.ok(textOf(result.content[0]).includes("image"));
        });

        it("keeps the number of forwarded images bounded", async () => {
            const handle = new FakeMcpClient("svc", [], async () => ({
                content: Array.from({ length: 8 }, () => ({
                    type: "image",
                    data: PNG_BASE64,
                    mimeType: "image/png",
                })),
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            const images = result.content.filter((c) => c.type === "image");
            const texts = result.content.filter((c) => c.type === "text");
            assert.equal(images.length, 5);
            assert.equal(texts.length, 3);
        });

        it("propagates MCP isError as details.isError", async () => {
            const handle = new FakeMcpClient("svc", [], async () => ({
                content: [{ type: "text", text: "boom" }],
                isError: true,
            }));
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.equal(result.details.isError, true);
        });

        it("turns a thrown callTool into a readable error instead of bubbling", async () => {
            const handle = new FakeMcpClient("svc", [], async () => {
                throw new Error("connection lost");
            });
            const tool = makeTool({ handle });
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
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
                () => invokeTool(tool, {}, {} as never, { toolCallId: "t1", signal: ac.signal }),
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
                () => invokeTool(tool, {}, {} as never, { toolCallId: "t1", signal: ac.signal }),
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
});

describe("mcpToolProvider", () => {
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
            const result = await invokeTool(tool, {}, {} as never, { toolCallId: "t1" });
            assert.equal((result.content[0] as { text: string }).text, "issue #1");
            assert.equal((result.details as { isError: boolean }).isError, false);
            assert.deepEqual(
                handle.calls.map((c) => c.name),
                ["list_issues"],
            );
        });
    });
});

describe("mcpStdio.e2e", () => {
    const silentLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    };

    const __dirname = fileURLToPath(new URL(".", import.meta.url));

    // A minimal MCP server with a single echo tool, built on the low-level Server
    // API so the tool's inputSchema is a raw JSON Schema (the shape real servers
    // emit and our adapter consumes). Runs as plain node so imports resolve from
    // the sidecar package's node_modules when spawned with cwd = pkgDir.
    const SERVER_SOURCE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the provided message back.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  return { content: [{ type: "text", text: "echo:" + String(args.message) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

    describe("MCP stdio e2e", () => {
        let tmpDir: string;
        let pkgDir: string;

        before(() => {
            tmpDir = mkdtempSync(join(tmpdir(), "taco-mcp-e2e-"));
            // Sidecar package root — where node_modules/@modelcontextprotocol lives.
            pkgDir = join(__dirname, "..", "..");
        });

        after(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it("discovers and calls a tool over real stdio", async () => {
            const cfg: McpServerConfig = {
                id: "echo",
                transport: "stdio",
                command: process.execPath,
                args: ["--input-type=module", "-e", SERVER_SOURCE],
                cwd: pkgDir,
                timeoutMs: 20_000,
            };

            const client = await createMcpClient(cfg, silentLogger as unknown as Logger);
            const tools = await client.listTools();
            assert.deepEqual(
                tools.map((t) => t.name),
                ["echo"],
            );
            assert.deepEqual(tools[0].inputSchema, {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
            });

            const result = await client.callTool("echo", { message: "hi" });
            // Successful MCP responses omit isError; the client forwards undefined.
            assert.equal(result.isError, undefined);
            assert.deepEqual(result.content, [{ type: "text", text: "echo:hi" }]);

            await client.close();
        });

        it("discovers through the provider and executes via the loaded candidate", async () => {
            const provider = await discoverMcpTools({
                servers: [
                    {
                        id: "echo",
                        transport: "stdio",
                        command: process.execPath,
                        args: ["--input-type=module", "-e", SERVER_SOURCE],
                        cwd: pkgDir,
                        timeoutMs: 20_000,
                    },
                ],
                log: silentLogger as unknown as Logger,
            });

            const candidates = provider.candidates();
            assert.equal(candidates.length, 1);
            assert.equal(candidates[0].name, "mcp__echo__echo");
            assert.equal(candidates[0].loading, "deferred");

            const tool = await candidates[0].load();
            const result = await invokeTool(tool, { message: "via-provider" }, {} as never, {
                toolCallId: "t1",
            });
            assert.equal((result.details as { isError: boolean }).isError, false);
            assert.equal((result.content[0] as { text: string }).text, "echo:via-provider");

            await provider.dispose();
        });

        // Regression: the SDK always forwards its `env` option to the spawn call,
        // and its own default is empty on macOS/Linux. Without our process.env
        // merge the child starts with no PATH, so a bare command name (the common
        // case in user configs) dies with ENOENT before the handshake. The other
        // cases here use an absolute process.execPath and would not catch it.
        it("resolves a bare command name, proving PATH reaches the child", async () => {
            const cfg: McpServerConfig = {
                id: "echo-bare",
                transport: "stdio",
                command: "node",
                args: ["--input-type=module", "-e", SERVER_SOURCE],
                cwd: pkgDir,
                timeoutMs: 20_000,
            };

            const client = await createMcpClient(cfg, silentLogger as unknown as Logger);
            const tools = await client.listTools();
            assert.deepEqual(
                tools.map((t) => t.name),
                ["echo"],
            );
            await client.close();
        });

        // Regression: spawn reports a missing cwd as ENOENT naming the *command*,
        // which reads as "your command is wrong" and hides the real cause. We check
        // the directory up front so the message names it instead.
        it("reports a missing cwd as such, not as a bad command", async () => {
            const missing = join(tmpDir, "definitely-not-created");
            const cfg: McpServerConfig = {
                id: "echo-bad-cwd",
                transport: "stdio",
                command: process.execPath,
                args: ["--input-type=module", "-e", SERVER_SOURCE],
                cwd: missing,
                timeoutMs: 20_000,
            };

            await assert.rejects(
                () => createMcpClient(cfg, silentLogger as unknown as Logger),
                (err: Error) => {
                    assert.match(err.message, /working directory does not exist/);
                    assert.ok(
                        err.message.includes(missing),
                        `expected the message to name the cwd, got: ${err.message}`,
                    );
                    assert.ok(
                        !err.message.includes("ENOENT"),
                        `expected no raw ENOENT, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        // The server's own env entries must still win over the inherited ones.
        it("lets cfg.env override inherited variables", async () => {
            const cfg: McpServerConfig = {
                id: "echo-env",
                transport: "stdio",
                command: "node",
                args: ["--input-type=module", "-e", SERVER_SOURCE],
                env: { TACO_MCP_E2E_MARKER: "from-cfg" },
                cwd: pkgDir,
                timeoutMs: 20_000,
            };

            const client = await createMcpClient(cfg, silentLogger as unknown as Logger);
            // Connecting at all means PATH survived the override merge.
            const tools = await client.listTools();
            assert.equal(tools.length, 1);
            await client.close();
        });
    });
});
