import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { before, describe, it, mock } from "node:test";
import type { CommandPermissionConfig } from "@taco-ai/protocol";
import { COMPACTION_THRESHOLD_MAX, COMPACTION_THRESHOLD_MIN } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import { registerConfigHandlers } from "../../src/server/handlers/config.ts";
import { registerSettingsHandlers } from "../../src/server/handlers/settings.ts";
import { createConfigTools } from "../../src/tools/config.ts";
import { callMethod } from "../_helpers/handlerCall.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";
import { sessionToolContext } from "../_helpers/toolContext.ts";

const home = useTempTacoHome("config-patch-tool");
const initial: CommandPermissionConfig = {
    mode: "ask",
    allow: ["git diff"],
    deny: ["git push *"],
    allowedDirectories: ["/workspace"],
};

function diskPermissions(): CommandPermissionConfig {
    return JSON.parse(readFileSync(join(home, "taco.json"), "utf8")).commandPermissions;
}

describe("configPatch tool through handler and persistence", () => {
    before(() => {
        registerConfigHandlers();
        registerSettingsHandlers();
    });

    function context(beforeApproval: () => void = () => {}) {
        const broker = new PermissionBroker(() => ({ mode: "ask" }), {
            requestTimeoutMs: 2_000,
        });
        broker.on("requested", (request) => {
            setImmediate(() => {
                beforeApproval();
                broker.resolve(request.requestId, true, "once");
            });
        });
        return sessionToolContext({
            call: async (method, workspace, params) =>
                callMethod(method, {
                    cwd: workspace,
                    params,
                    workspace: { getSessionKind: () => "main", permissionBroker: broker },
                }),
        });
    }

    for (const field of ["allowedDirectories", "rules"]) {
        const input = {
            patch: { commandPermissions: { mode: "auto", [field]: ["/extra"] } },
        };

        it(`rejects extra permission field ${field} in the tool schema`, () => {
            const { configPatch } = createConfigTools();
            assert.equal(Value.Check(configPatch.parameters, input), false);
        });

        it(`rejects extra permission field ${field} on direct execution before RPC`, async () => {
            saveGlobalConfig({ commandPermissions: initial });
            let calls = 0;
            const ctx = context();
            const call = ctx.call;
            assert.ok(call);
            ctx.call = async (method, workspace, params) => {
                calls++;
                return call(method, workspace, params);
            };
            const { configPatch } = createConfigTools();
            await assert.rejects(
                invokeTool(configPatch, input, ctx),
                /configPatch: unsupported commandPermissions field/,
            );
            assert.equal(calls, 0);
            assert.deepEqual(diskPermissions(), initial);
        });
    }

    it("refuses to set the outbound User-Agent", async () => {
        // The UA is the identity every provider request presents — a model
        // that rewrites it changes how the user is seen by every provider.
        saveGlobalConfig({ userAgent: "my-gateway/1.0" });
        let calls = 0;
        const ctx = context();
        const call = ctx.call;
        assert.ok(call);
        ctx.call = async (method, workspace, params) => {
            calls++;
            return call(method, workspace, params);
        };
        const { configPatch } = createConfigTools();
        await assert.rejects(
            invokeTool(configPatch, { patch: { userAgent: "spoofed/1.0" } }, ctx),
            /configPatch: userAgent is not settable here/,
        );
        assert.equal(calls, 0);
        assert.equal(readGlobalConfig().userAgent, "my-gateway/1.0");
    });

    it("refuses to set the product name", async () => {
        // The name renames the assistant in every prompt, and the running
        // identity only changes on the next restart — so it is the user's
        // to set, through the settings entry.
        saveGlobalConfig({ defaultModel: "keep-me" });
        let calls = 0;
        const ctx = context();
        const call = ctx.call;
        assert.ok(call);
        ctx.call = async (method, workspace, params) => {
            calls++;
            return call(method, workspace, params);
        };
        const { configPatch } = createConfigTools();
        await assert.rejects(
            invokeTool(configPatch, { patch: { productName: "Acme" } }, ctx),
            /configPatch: productName is not settable here/,
        );
        assert.equal(calls, 0);
        assert.equal(readGlobalConfig().defaultModel, "keep-me");
    });

    // Fields outside the writable set carry secret material `configGet`
    // masks on read, or are plain not the model's to write. The tool has to
    // refuse them before the user is asked — a whole-array replace (MCP
    // servers, channels) would drop secrets the model never saw.
    for (const field of [
        "anthropicApiKey",
        "openaiApiKey",
        "apiKeys",
        "customProviders",
        "mcpServers",
        "channels",
        "sessionsRoot",
    ]) {
        it(`refuses to write ${field} before the user is asked`, async () => {
            saveGlobalConfig({ defaultModel: "keep-me" });
            let calls = 0;
            const ctx = context();
            const call = ctx.call;
            assert.ok(call);
            ctx.call = async (method, workspace, params) => {
                calls++;
                return call(method, workspace, params);
            };
            const { configPatch } = createConfigTools();
            await assert.rejects(
                invokeTool(configPatch, { patch: { [field]: "x" } }, ctx),
                /is not settable here/,
            );
            assert.equal(calls, 0);
            assert.equal(readGlobalConfig().defaultModel, "keep-me");
        });
    }

    for (const [name, patch] of [
        ["mode", { mode: "auto" }],
        ["allow replacement", { allow: ["pnpm test"] }],
        ["deny replacement", { deny: ["git reset *"] }],
        ["explicit allow clear", { allow: [] }],
        ["explicit deny clear", { deny: [] }],
        ["empty permission patch", {}],
    ] as const) {
        it(`preserves omitted permission fields for ${name}`, async () => {
            saveGlobalConfig({ commandPermissions: initial });
            const input = { patch: { commandPermissions: patch } };
            const { configPatch } = createConfigTools();
            assert.equal(Value.Check(configPatch.parameters, input), true);
            const result = await invokeTool(configPatch, input, context());
            assert.equal((result.details as { approved: boolean }).approved, true);
            assert.deepEqual(diskPermissions(), { ...initial, ...patch });
        });
    }

    it("preserves permission changes made after configGet while approval is pending", async () => {
        saveGlobalConfig({ commandPermissions: initial });
        const latest = {
            ...initial,
            allow: ["pnpm test"],
            deny: ["git reset *"],
            allowedDirectories: ["/new-workspace"],
        };
        const ctx = context(() => saveGlobalConfig({ commandPermissions: latest }));
        const { configGet, configPatch } = createConfigTools();
        await invokeTool(configGet, {}, ctx);
        await invokeTool(configPatch, { patch: { commandPermissions: { mode: "auto" } } }, ctx);
        assert.deepEqual(diskPermissions(), { ...latest, mode: "auto" });
    });

    it("keeps settings.write permission replacement semantics", async () => {
        saveGlobalConfig({ commandPermissions: initial });
        await callMethod("settings.write", {
            params: { global: { commandPermissions: { mode: "auto" } } },
        });
        assert.deepEqual(diskPermissions(), { mode: "auto", allow: [], deny: [] });
    });

    it("derives omitted permissions only after acquiring the config lock", async () => {
        saveGlobalConfig({ commandPermissions: initial });
        const latest = { ...initial, allow: ["pnpm test"], allowedDirectories: ["/latest"] };
        const rename = fs.renameSync;
        let injected = false;
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
            const result = rename(...args);
            if (String(args[1]) === join(home, "taco.json.lock")) {
                injected = true;
                writeFileSync(
                    join(home, "taco.json"),
                    JSON.stringify({ commandPermissions: latest }),
                );
            }
            return result;
        });
        syncBuiltinESMExports();
        try {
            const { configPatch } = createConfigTools();
            await invokeTool(
                configPatch,
                { patch: { commandPermissions: { mode: "auto" } } },
                context(),
            );
            assert.equal(injected, true);
            assert.deepEqual(diskPermissions(), { ...latest, mode: "auto" });
        } finally {
            mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    for (const threshold of [COMPACTION_THRESHOLD_MIN, COMPACTION_THRESHOLD_MAX]) {
        it(`accepts and persists compaction threshold boundary ${threshold}`, async () => {
            const { configPatch } = createConfigTools();
            const input = { patch: { compaction: { threshold } } };
            assert.equal(Value.Check(configPatch.parameters, input), true);
            await invokeTool(configPatch, input, context());
            const config = JSON.parse(readFileSync(join(home, "taco.json"), "utf8"));
            assert.equal(config.compaction.threshold, threshold);
        });
    }

    for (const threshold of [0, 0.05, 0.99, 1]) {
        it(`rejects out-of-range compaction threshold ${threshold} in the tool schema`, () => {
            const { configPatch } = createConfigTools();
            assert.equal(
                Value.Check(configPatch.parameters, { patch: { compaction: { threshold } } }),
                false,
            );
        });
    }
});
