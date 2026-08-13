/**
 * mcp.getConfig / createConfig / updateConfig / deleteConfig handler tests.
 *
 * Covers the per-entry MCP config RPC contract:
 *   - settings.get keeps returning a masked summary (no command/args/env/headers/url).
 *   - mcp.getConfig is the only path that returns the full raw config for one server.
 *   - updateConfig merges field-wise, preserving sensitive fields on disk.
 *   - createConfig rejects duplicate ids; deleteConfig removes only the target.
 *   - every write RPC reports requiresRestart: true.
 *   - malformed input surfaces as `invalid_params` through the real dispatch
 *     path (normalizeError), not `internal`.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/mcp.config.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { McpServerConfig, McpServerConfigView } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { ProviderKeyStore } from "../../../src/runtime/providerKeyStore.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    // Hermetic: point TACO_HOME at a temp dir so the write RPCs touch only
    // the temp taco.json, never the real ~/.taco/taco.json.
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-mcp-config-"));
    process.env.TACO_HOME = tmpDir;
    registerBuiltinMethods();
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

async function callHandler(name: string, params: unknown): Promise<unknown> {
    const reg = getRegisteredMethod(name);
    if (!reg) throw new Error(`unregistered: ${name}`);
    return reg.handler({
        id: "test",
        workspace: undefined as never,
        cwd: undefined as never,
        server: undefined as never,
        params,
    });
}

/** A stdio server carrying every sensitive field the masks must strip. */
function fullServer(id = "dbx"): McpServerConfig {
    return {
        id,
        transport: "stdio",
        command: "node",
        args: ["/opt/dbx/server.js"],
        env: { DBX_TOKEN: "super-secret" },
        headers: { Authorization: "Bearer xyz" },
        url: "https://internal.example.com",
        timeoutMs: 3000,
        alwaysLoaded: ["query"],
        enabled: true,
    };
}

describe("mcp per-entry config RPCs", () => {
    it("settings.get mcpServers stays masked — no command/args/env/headers/url", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        const result = (await callHandler("settings.get", undefined)) as {
            global: { mcpServers?: McpServerConfigView[] };
        };
        const view = result.global.mcpServers?.[0];
        assert.ok(view, "expected one mcpServers entry in the settings view");
        assert.equal(view.id, "dbx");
        assert.equal(view.transport, "stdio");
        assert.equal(view.enabled, true);
        assert.equal(view.timeoutMs, 3000);
        assert.deepEqual(view.alwaysLoaded, ["query"]);
        for (const secretField of ["command", "args", "env", "headers", "url"]) {
            assert.equal(
                secretField in view,
                false,
                `${secretField} must be stripped from the view`,
            );
        }
    });

    it("mcp.getConfig returns the full raw single entry", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        const result = (await callHandler("mcp.getConfig", { id: "dbx" })) as {
            config: McpServerConfig;
        };
        assert.deepEqual(result.config, fullServer());
    });

    it("mcp.getConfig rejects an unknown id with not_found", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        await assert.rejects(
            callHandler("mcp.getConfig", { id: "missing" }),
            (e: unknown) => e instanceof Error && e.message.includes("not found: missing"),
        );
    });

    it("mcp.updateConfig merges field-wise and preserves sensitive fields on disk", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        const result = (await callHandler("mcp.updateConfig", {
            id: "dbx",
            patch: { enabled: false, alwaysLoaded: ["query", "sync"] },
        })) as { server: McpServerConfigView; requiresRestart: true };
        assert.equal(result.server.enabled, false);
        assert.deepEqual(result.server.alwaysLoaded, ["query", "sync"]);
        assert.equal(result.requiresRestart, true);

        const onDisk = readGlobalConfig().mcpServers?.[0];
        assert.ok(onDisk, "server should still exist after update");
        // Sensitive fields the patch did not touch must survive the merge.
        assert.equal(onDisk.command, "node");
        assert.deepEqual(onDisk.args, ["/opt/dbx/server.js"]);
        assert.deepEqual(onDisk.env, { DBX_TOKEN: "super-secret" });
        assert.deepEqual(onDisk.headers, { Authorization: "Bearer xyz" });
        assert.equal(onDisk.url, "https://internal.example.com");
        assert.equal(onDisk.id, "dbx", "id must not change via patch");
    });

    it("mcp.updateConfig rejects an id change in the patch", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        const result = (await callHandler("mcp.updateConfig", {
            id: "dbx",
            patch: { id: "hijacked", enabled: true },
        })) as { server: McpServerConfigView };
        // The server-side merge pins id to params.id — a patch cannot rename it.
        assert.equal(result.server.id, "dbx");
        const onDisk = readGlobalConfig().mcpServers?.[0];
        assert.equal(onDisk?.id, "dbx");
    });

    it("mcp.createConfig adds the entry and reports requiresRestart", async () => {
        saveGlobalConfig({ mcpServers: [fullServer("existing")] });
        const created = fullServer("new-srv");
        const result = (await callHandler("mcp.createConfig", { config: created })) as {
            server: McpServerConfigView;
            requiresRestart: true;
        };
        assert.equal(result.server.id, "new-srv");
        assert.equal(result.requiresRestart, true);
        const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
        assert.deepEqual(ids, ["existing", "new-srv"]);
    });

    it("mcp.createConfig rejects a duplicate id", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        await assert.rejects(
            callHandler("mcp.createConfig", { config: fullServer() }),
            (e: unknown) => e instanceof Error && e.message.includes("duplicate id"),
        );
        // Nothing was written — the original server is still the only one.
        const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
        assert.deepEqual(ids, ["dbx"]);
    });

    it("mcp.deleteConfig removes only the target and reports requiresRestart", async () => {
        saveGlobalConfig({ mcpServers: [fullServer("keep"), fullServer("drop")] });
        const result = (await callHandler("mcp.deleteConfig", { id: "drop" })) as {
            deleted: string;
            requiresRestart: true;
        };
        assert.equal(result.deleted, "drop");
        assert.equal(result.requiresRestart, true);
        const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
        assert.deepEqual(ids, ["keep"]);
    });

    it("mcp.deleteConfig rejects an unknown id with not_found", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        await assert.rejects(
            callHandler("mcp.deleteConfig", { id: "missing" }),
            (e: unknown) => e instanceof Error && e.message.includes("not found: missing"),
        );
    });
});

describe("mcp config malformed input — through the real dispatch path", () => {
    // Call via SidecarServer.dispatchRpc so normalizeError translates the
    // handler's throw into an RpcResponse.error. A regression where the
    // handler lets validateMcpServers's plain Error escape would surface here
    // as code "internal" instead of "invalid_params".
    function dispatch(req: {
        method: string;
        params: unknown;
    }): Promise<{ ok: boolean; error?: { code: string } }> {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        return server.dispatchRpc({ id: "req-1", ...req });
    }

    it("mcp.createConfig duplicate id → error code invalid_params", async () => {
        saveGlobalConfig({ mcpServers: [fullServer()] });
        const resp = await dispatch({
            method: "mcp.createConfig",
            params: { config: fullServer() },
        });
        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "invalid_params");
        // Nothing written.
        assert.deepEqual(
            (readGlobalConfig().mcpServers ?? []).map((s) => s.id),
            ["dbx"],
        );
    });

    it("mcp.createConfig malformed transport → error code invalid_params", async () => {
        saveGlobalConfig({ mcpServers: [] });
        const resp = await dispatch({
            method: "mcp.createConfig",
            params: {
                config: { id: "bad", transport: "tcp", command: "echo" },
            },
        });
        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "invalid_params");
    });

    it("mcp.updateConfig malformed patch → error code invalid_params", async () => {
        saveGlobalConfig({ mcpServers: [fullServer("a"), fullServer("b")] });
        const resp = await dispatch({
            method: "mcp.updateConfig",
            params: { id: "a", patch: { transport: "tcp" } },
        });
        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "invalid_params");
    });
});
