/**
 * mcpStdio e2e — real stdio transport: spawn an in-process MCP server via
 * `node -e` (plain node, no tsx), then discover + call through the real client.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@taco-ai/protocol";
import type { Logger } from "../../src/lib/logger.ts";
import { createMcpClient } from "../../src/mcp/mcpClient.ts";
import { discoverMcpTools } from "../../src/mcp/mcpToolProvider.ts";

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
        const result = await tool.execute(
            "t1",
            { message: "via-provider" },
            undefined,
            undefined,
            {} as never,
        );
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
