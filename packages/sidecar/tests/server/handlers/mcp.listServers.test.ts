/**
 * mcp.listServers handler — exercise `probeMcpServers` with a fake
 * McpClientFactory. The RPC wrapper itself is trivial (readGlobalConfig +
 * ids filter + delegate); `probeMcpServers` carries the only behavior worth
 * pinning.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { McpServerConfig } from "@taco-ai/protocol";
import type { McpClientFactory, McpClientHandle } from "../../../src/mcp/mcpClient.ts";
import { probeMcpServers } from "../../../src/server/handlers/mcp.ts";
import { FakeMcpClient } from "../../_helpers/fakeMcpClient.ts";

const server = (id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
    id,
    transport: "stdio",
    command: "echo",
    ...overrides,
});

function factoryFrom(handles: Map<string, McpClientHandle>): McpClientFactory {
    return async (cfg) => {
        const h = handles.get(cfg.id);
        if (!h) throw new Error(`no handle for ${cfg.id}`);
        return h;
    };
}

describe("probeMcpServers", () => {
    it("maps successful listTools to status:ok with toolCount and tool names", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "gh",
                new FakeMcpClient("gh", [
                    { name: "list_issues", inputSchema: { type: "object", properties: {} } },
                    { name: "merge_pr", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const [view] = await probeMcpServers([server("gh")], factoryFrom(handles));
        assert.equal(view.id, "gh");
        assert.equal(view.transport, "stdio");
        assert.equal(view.status, "ok");
        assert.equal(view.toolCount, 2);
        assert.deepEqual(view.tools, ["list_issues", "merge_pr"]);
        assert.equal(view.connectError, undefined);
    });

    it("maps a thrown factory error to status:error with connectError from Error.message", async () => {
        const factory: McpClientFactory = async () => {
            throw new Error("connection refused");
        };
        const [view] = await probeMcpServers([server("bad")], factory);
        assert.equal(view.status, "error");
        assert.equal(view.toolCount, 0);
        assert.deepEqual(view.tools, []);
        assert.equal(view.connectError, "connection refused");
    });

    it("isolates one failing server without affecting the others", async () => {
        const handles = new Map<string, McpClientHandle>([
            [
                "ok",
                new FakeMcpClient("ok", [
                    { name: "fine", inputSchema: { type: "object", properties: {} } },
                ]),
            ],
        ]);
        const factory: McpClientFactory = async (cfg) => {
            if (cfg.id === "bad") throw new Error("boom");
            return factoryFrom(handles)(cfg);
        };
        const views = await probeMcpServers([server("ok"), server("bad")], factory);
        assert.deepEqual(
            views.map((v) => [v.id, v.status]),
            [
                ["ok", "ok"],
                ["bad", "error"],
            ],
        );
    });

    it("skips disabled servers by default — returns status:skipped without invoking the factory", async () => {
        let factoryCalls = 0;
        const factory: McpClientFactory = async (cfg) => {
            factoryCalls += 1;
            return new FakeMcpClient(cfg.id, []);
        };
        const views = await probeMcpServers(
            [
                server("on"),
                server("off", { enabled: false }),
                server("also-off", { enabled: false }),
            ],
            factory,
        );
        assert.equal(factoryCalls, 1, "only the enabled server invokes the factory");
        const byId = new Map(views.map((v) => [v.id, v]));
        assert.equal(byId.get("on")?.status, "ok");
        assert.equal(byId.get("off")?.status, "skipped");
        assert.equal(byId.get("also-off")?.status, "skipped");
        assert.equal(byId.get("off")?.toolCount, 0);
        assert.deepEqual(byId.get("off")?.tools, []);
        assert.equal(byId.get("off")?.connectError, undefined);
    });

    it("probes disabled servers when skipDisabled is false (force probe path)", async () => {
        const handles = new Map<string, McpClientHandle>([
            ["a", new FakeMcpClient("a", [])],
            ["b", new FakeMcpClient("b", [])],
        ]);
        const views = await probeMcpServers(
            [server("a", { enabled: false }), server("b", { enabled: false })],
            factoryFrom(handles),
            false,
        );
        assert.equal(views.length, 2);
        assert.equal(
            views.every((v) => v.status === "ok"),
            true,
        );
    });

    it("preserves input order across results", async () => {
        const handles = new Map<string, McpClientHandle>(
            ["a", "b", "c"].map((id) => [id, new FakeMcpClient(id, [])] as const),
        );
        const ids = ["a", "b", "c"];
        const views = await probeMcpServers(
            ids.map((id) => server(id)),
            factoryFrom(handles),
        );
        assert.deepEqual(
            views.map((v) => v.id),
            ids,
        );
    });

    it("returns one view per input, even when caller filters by ids", async () => {
        // The handler does the ids filter before calling probeMcpServers; this
        // test pins the contract that probeMcpServers returns exactly one view
        // per entry it receives (no merging, no dedupe).
        const handles = new Map<string, McpClientHandle>(
            ["a", "b", "c"].map((id) => [id, new FakeMcpClient(id, [])] as const),
        );
        const views = await probeMcpServers([server("a"), server("b")], factoryFrom(handles));
        assert.deepEqual(
            views.map((v) => v.id),
            ["a", "b"],
        );
    });

    it("reports status:ok even when the post-success close() throws", async () => {
        // Regression: the post-listTools close() used to bubble out of the
        // success branch and surface to the caller as {status:"error",
        // connectError: <close error>}. That misreports the probe's actual
        // outcome. The fix swallows the close error after a successful
        // listTools so the view remains "ok" with the captured tools.
        const handle = new FakeMcpClient("flaky-close", [
            { name: "tool_a", inputSchema: { type: "object", properties: {} } },
        ]);
        handle.closeError = new Error("transport already torn down");
        const [view] = await probeMcpServers([server("flaky-close")], factoryFrom(handles(handle)));
        assert.equal(view.status, "ok");
        assert.equal(view.toolCount, 1);
        assert.deepEqual(view.tools, ["tool_a"]);
        assert.equal(view.connectError, undefined);
    });

    it("still surfaces listTools failures (post-success close is the only thing we swallow)", async () => {
        const handle = new FakeMcpClient("explode", [
            { name: "tool_a", inputSchema: { type: "object", properties: {} } },
        ]);
        handle.listTools = async () => {
            throw new Error("rpc broken");
        };
        const [view] = await probeMcpServers([server("explode")], factoryFrom(handles(handle)));
        assert.equal(view.status, "error");
        assert.equal(view.connectError, "rpc broken");
    });
});

function handles(h: McpClientHandle): Map<string, McpClientHandle> {
    return new Map([[h.serverId, h]]);
}
