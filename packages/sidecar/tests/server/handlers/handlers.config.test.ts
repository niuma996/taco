/** Consolidated from 3 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { ConfigPatchResult, McpServerConfig, McpServerConfigView } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import type { McpClientFactory, McpClientHandle } from "../../../src/mcp/mcpClient.ts";
import { PermissionBroker } from "../../../src/permissions/permissionBroker.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { probeMcpServers } from "../../../src/server/handlers/mcp.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";
import { FakeMcpClient } from "../../_helpers/fakeMcpClient.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("config", () => {
    /**
     * config.* handlers — the approval gate.
     *
     * The handler is where a model-proposed config change becomes a real write,
     * so these tests pin the two properties that matter: nothing is written
     * without an approval, and the reason for a denial reaches the caller (the
     * tool turns it into guidance, and "the user said no" and "nobody answered"
     * call for different behaviour).
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/config.test.ts
     */

    before(() => {
        registerBuiltinMethods();
    });

    let tmpRoot: string;
    let prevTacoHome: string | undefined;

    beforeEach(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpRoot = mkdtempSync(join(tmpdir(), "taco-config-handlers-"));
        process.env.TACO_HOME = tmpRoot;
    });

    afterEach(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    /**
     * A broker whose requests are answered by the test. `answer` decides what the
     * user does; a request that is never answered times out, so the test must
     * always answer.
     */
    function makeBroker(answer: (requestId: string) => void): PermissionBroker {
        // Bounded timeout: a test that never gets its answer (e.g. a regressed
        // guard that lets the request through to the broker) fails in seconds
        // instead of the 10-minute default. It cannot be much shorter — the
        // answer below is delivered on the next tick, and under a loaded event
        // loop that tick can be delayed by more than a few tens of
        // milliseconds, which turned the denial into a timeout.
        const broker = new PermissionBroker(() => ({ mode: "ask" }) as const, {
            requestTimeoutMs: 2_000,
        });
        broker.on("requested", (request) => {
            // The approval is a prompt the user sees; answer it on the next tick
            // so the request is registered before it is resolved.
            setImmediate(() => answer(request.requestId));
        });
        return broker;
    }

    function makeCtx(workspace: Partial<WorkspaceRuntime>, params: unknown, cwd = "/tmp/ws") {
        return {
            id: "test-id",
            workspace: { getSessionKind: () => "main", ...workspace } as WorkspaceRuntime,
            cwd,
            server: new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) }),
            params,
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
    }

    const patchParams = {
        workspace: "/tmp/ws",
        sessionId: "s1",
        toolCallId: "tc1",
        patch: { defaultModel: "claude-opus-5" },
    };

    describe("config.patch", () => {
        it("writes nothing and reports the user's denial", async () => {
            const broker = makeBroker((requestId) => {
                broker.resolve(requestId, false, "once");
            });
            const handler = getRegisteredMethod("config.patch");
            assert.ok(handler);

            const result = (await handler.handler(
                makeCtx({ permissionBroker: broker }, patchParams),
            )) as ConfigPatchResult;

            assert.equal(result.approved, false);
            assert.deepEqual(result.fields, ["defaultModel"]);
            // The reason has to survive: the tool tells the model not to retry on a
            // user denial, but that asking is fine on a timeout.
            assert.equal(result.denialReason, "user_denied");
        });

        it("reports a missing approver separately from a user denial", async () => {
            const broker = new PermissionBroker(() => ({ mode: "ask" }) as const, {
                hasApprover: () => false,
            });
            const handler = getRegisteredMethod("config.patch");
            assert.ok(handler);

            const result = (await handler.handler(
                makeCtx({ permissionBroker: broker }, patchParams),
            )) as ConfigPatchResult;

            assert.equal(result.approved, false);
            assert.equal(result.denialReason, "no_approver");
        });

        it("refuses an empty patch", async () => {
            const broker = makeBroker(() => {});
            const handler = getRegisteredMethod("config.patch");
            assert.ok(handler);

            await assert.rejects(
                () =>
                    handler.handler(
                        makeCtx(
                            { permissionBroker: broker },
                            {
                                ...patchParams,
                                patch: {},
                            },
                        ),
                    ),
                /touches no fields/,
            );
        });

        it("refuses subagent and IM sessions without asking the user", async () => {
            const broker = makeBroker(() => {});
            const handler = getRegisteredMethod("config.patch");
            assert.ok(handler);

            await assert.rejects(
                () =>
                    handler.handler(
                        makeCtx(
                            { permissionBroker: broker, getSessionKind: () => "subagent" },
                            patchParams,
                        ),
                    ),
                /local main session/,
            );
            await assert.rejects(
                () =>
                    handler.handler(
                        makeCtx({ permissionBroker: broker }, patchParams, "im://c/p/t"),
                    ),
                /local main session/,
            );
        });
    });
});

describe("mcp.config", () => {
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

    useTempTacoHome("mcp-config");

    before(() => {
        registerBuiltinMethods();
    });

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
            const result = await callMethod<{
                global: { mcpServers?: McpServerConfigView[] };
            }>("settings.get");
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
            const result = await callMethod<{ config: McpServerConfig }>("mcp.getConfig", {
                params: { id: "dbx" },
            });
            assert.deepEqual(result.config, fullServer());
        });

        it("mcp.getConfig rejects an unknown id with not_found", async () => {
            saveGlobalConfig({ mcpServers: [fullServer()] });
            await assert.rejects(
                callMethod("mcp.getConfig", { params: { id: "missing" } }),
                (e: unknown) => e instanceof Error && e.message.includes("not found: missing"),
            );
        });

        it("mcp.updateConfig merges field-wise and preserves sensitive fields on disk", async () => {
            saveGlobalConfig({ mcpServers: [fullServer()] });
            const result = await callMethod<{
                server: McpServerConfigView;
                requiresRestart: true;
            }>("mcp.updateConfig", {
                params: { id: "dbx", patch: { enabled: false, alwaysLoaded: ["query", "sync"] } },
            });
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
            const result = await callMethod<{ server: McpServerConfigView }>("mcp.updateConfig", {
                params: { id: "dbx", patch: { id: "hijacked", enabled: true } },
            });
            // The server-side merge pins id to params.id — a patch cannot rename it.
            assert.equal(result.server.id, "dbx");
            const onDisk = readGlobalConfig().mcpServers?.[0];
            assert.equal(onDisk?.id, "dbx");
        });

        it("mcp.createConfig adds the entry and reports requiresRestart", async () => {
            saveGlobalConfig({ mcpServers: [fullServer("existing")] });
            const created = fullServer("new-srv");
            const result = await callMethod<{
                server: McpServerConfigView;
                requiresRestart: true;
            }>("mcp.createConfig", { params: { config: created } });
            assert.equal(result.server.id, "new-srv");
            assert.equal(result.requiresRestart, true);
            const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
            assert.deepEqual(ids, ["existing", "new-srv"]);
        });

        it("mcp.createConfig rejects a duplicate id", async () => {
            saveGlobalConfig({ mcpServers: [fullServer()] });
            await assert.rejects(
                callMethod("mcp.createConfig", { params: { config: fullServer() } }),
                (e: unknown) => e instanceof Error && e.message.includes("duplicate id"),
            );
            // Nothing was written — the original server is still the only one.
            const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
            assert.deepEqual(ids, ["dbx"]);
        });

        it("mcp.deleteConfig removes only the target and reports requiresRestart", async () => {
            saveGlobalConfig({ mcpServers: [fullServer("keep"), fullServer("drop")] });
            const result = await callMethod<{
                deleted: string;
                requiresRestart: true;
            }>("mcp.deleteConfig", { params: { id: "drop" } });
            assert.equal(result.deleted, "drop");
            assert.equal(result.requiresRestart, true);
            const ids = (readGlobalConfig().mcpServers ?? []).map((s) => s.id);
            assert.deepEqual(ids, ["keep"]);
        });

        it("mcp.deleteConfig rejects an unknown id with not_found", async () => {
            saveGlobalConfig({ mcpServers: [fullServer()] });
            await assert.rejects(
                callMethod("mcp.deleteConfig", { params: { id: "missing" } }),
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
});

describe("mcp.listServers", () => {
    /**
     * mcp.listServers handler — exercise `probeMcpServers` with a fake
     * McpClientFactory. The RPC wrapper itself is trivial (readGlobalConfig +
     * ids filter + delegate); `probeMcpServers` carries the only behavior worth
     * pinning.
     */

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
            const [view] = await probeMcpServers(
                [server("flaky-close")],
                factoryFrom(handles(handle)),
            );
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
});
