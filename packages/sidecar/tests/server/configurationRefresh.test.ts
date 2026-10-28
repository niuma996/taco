import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { resolveConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";

const provider = {
    id: "custom:refresh",
    name: "Refresh",
    api: "chatcomplete" as const,
    baseUrl: "https://example.invalid/v1",
    models: [{ id: "model", contextWindow: 128000 }],
};

test("settings writes apply one effective configuration and preserve CLI defaults", async (t) => {
    const cli = { defaultProvider: provider.id, defaultModel: "model" };
    const server = new SidecarServer({
        ...cli,
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => resolveConfig(cli),
    });
    const custom = t.mock.method(server, "setCustomProviders");
    const defaults = t.mock.method(server, "setDefaultModel");
    const broadcasts = t.mock.method(server, "broadcastModelsChanged");
    try {
        const response = await server.dispatchRpc({
            id: "write",
            method: "settings.write",
            params: {
                global: {
                    customProviders: [provider],
                    defaultProvider: "anthropic",
                    defaultModel: "disk-model",
                },
            },
        });
        assert.ok(response.ok);
        await server.refreshConfiguration();
        assert.equal(custom.mock.callCount(), 1);
        assert.equal(defaults.mock.callCount(), 1);
        assert.deepEqual(defaults.mock.calls[0].arguments, ["model", provider.id]);
        assert.equal(broadcasts.mock.callCount(), 1);
    } finally {
        await server.stop();
    }
});

test("external catalog edits re-resolve workspace defaults and announce once", async (t) => {
    saveGlobalConfig({
        customProviders: [provider],
        defaultProvider: provider.id,
        defaultModel: "model",
    });
    const config = resolveConfig();
    const server = new SidecarServer({
        ...config,
        providerKeyStore: new ProviderKeyStore(config.apiKeys),
        resolveConfig,
    });
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-config-apply-")));
    try {
        const workspace = await server.ensureWorkspace(cwd);
        const broadcasts = t.mock.method(server, "broadcastModelsChanged");
        saveGlobalConfig({
            customProviders: [{ ...provider, models: [{ id: "model", contextWindow: 654321 }] }],
        });
        await server.refreshConfiguration();
        assert.equal(workspace.defaultModel?.contextWindow, 654321);
        assert.equal(await server.ensureWorkspace(cwd), workspace);
        assert.equal(broadcasts.mock.callCount(), 1);
        const response = await server.dispatchRpc({
            id: "same",
            method: "settings.write",
            params: {
                global: {
                    customProviders: [
                        { ...provider, models: [{ id: "model", contextWindow: 654321 }] },
                    ],
                },
            },
        });
        assert.ok(response.ok);
        assert.equal(broadcasts.mock.callCount(), 1);
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("configuration refresh removes credentials deleted outside the process", async () => {
    const { writeFile } = await import("node:fs/promises");
    saveGlobalConfig({ apiKeys: { removable: "secret" } });
    const config = resolveConfig();
    const keys = new ProviderKeyStore(config.apiKeys);
    const server = new SidecarServer({ ...config, providerKeyStore: keys, resolveConfig });
    try {
        const { tacoHome } = await import("../../src/config/tacoHome.ts");
        await writeFile(join(tacoHome(), "taco.json"), "{}");
        await server.refreshConfiguration();
        assert.equal(keys.has("removable"), false);
    } finally {
        await server.stop();
    }
});

test("a default host starts from the same effective config it later compares", async () => {
    saveGlobalConfig({
        customProviders: [provider],
        defaultProvider: provider.id,
        defaultModel: "model",
        instructions: { enabled: false },
    });
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-initial-config-")));
    try {
        const workspace = await server.ensureWorkspace(cwd);
        assert.equal(workspace.defaultModel?.provider, provider.id);
        assert.equal(workspace.defaultModel?.id, "model");
        assert.equal(workspace.instructionsConfig?.enabled, false);
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("undefined constructor fields keep resolver defaults and resolved credentials", async () => {
    const current = {
        ...resolveConfig(),
        customProviders: [provider],
        defaultProvider: provider.id,
        defaultModel: "model",
        apiKeys: { [provider.id]: "configured-secret" },
    };
    const keys = new ProviderKeyStore({});
    const server = new SidecarServer({
        defaultModel: undefined,
        defaultProvider: undefined,
        providerKeyStore: keys,
        resolveConfig: () => current,
    });
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-config-undefined-")));
    try {
        const workspace = await server.ensureWorkspace(cwd);
        assert.equal(workspace.defaultModel?.id, "model");
        assert.equal(workspace.defaultModel?.provider, provider.id);
        assert.equal(keys.get(provider.id), "configured-secret");
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an unchanged refresh preserves explicit MCP defaults until disk configuration changes", async () => {
    saveGlobalConfig({ mcpServers: [] });
    const explicit = [
        { id: "explicit", transport: "stdio" as const, command: "unused", enabled: false },
    ];
    const server = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        mcpServers: explicit,
    });
    const internals = server as unknown as { mcpServers: unknown };
    try {
        await server.refreshConfiguration();
        assert.deepEqual(internals.mcpServers, explicit);
        const updated = [{ ...explicit[0], id: "updated" }];
        saveGlobalConfig({ mcpServers: updated });
        await server.refreshConfiguration();
        assert.deepEqual(internals.mcpServers, updated);
    } finally {
        await server.stop();
    }
});

test("approved config.patch uses the same refresh and does not apply again on workspace access", async (t) => {
    saveGlobalConfig({ instructions: { enabled: true } });
    const { asSessionId } = await import("@taco-ai/protocol");
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-approved-config-")));
    try {
        const workspace = await server.ensureWorkspace(cwd);
        t.mock.method(workspace, "getSessionKind", () => "main");
        const approve = t.mock.method(
            workspace.permissionBroker,
            "requestConfigApproval",
            async () => ({ approved: true, scope: "once" as const }),
        );
        const instructions = t.mock.method(server, "refreshInstructions");
        const response = await server.dispatchRpc({
            id: "approved",
            method: "config.patch",
            params: {
                workspace: cwd,
                sessionId: asSessionId("approved-session"),
                toolCallId: "approved-tool",
                patch: { instructions: { enabled: false } },
            },
        });
        assert.ok(response.ok, JSON.stringify(response));
        assert.equal(approve.mock.callCount(), 1);
        assert.equal(workspace.instructionsConfig?.enabled, false);
        await server.ensureWorkspace(cwd);
        assert.equal(instructions.mock.callCount(), 1);
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});
