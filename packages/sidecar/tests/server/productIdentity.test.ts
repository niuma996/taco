// Product identity lifecycle at the server level.
//
// The identity is a STARTUP snapshot: a name saved after the sidecar started
// takes effect on the next restart, not on a configuration refresh. These
// tests pin that contract, plus the isolation between two server instances.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { test } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { resolveConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

// Without this the writes below land in the user's real ~/.taco/taco.json.
useTempTacoHome("product-identity");

async function workspaceDir(tag: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `taco-product-identity-${tag}-`));
}

test("a saved product name does not change the running identity until restart", async () => {
    saveGlobalConfig({ productName: "Acme" });
    const server = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => resolveConfig(),
    });
    const first = asWorkspaceId(await workspaceDir("first"));
    const second = asWorkspaceId(await workspaceDir("second"));
    try {
        const existing = await server.ensureWorkspace(first);
        assert.match(existing.systemPrompt, /You are the Acme assistant/);

        saveGlobalConfig({ productName: "Beta" });
        await server.refreshConfiguration();

        // The workspace built before the change keeps the name it started with.
        assert.match(existing.systemPrompt, /You are the Acme assistant/);
        // A workspace built after the refresh uses the same startup snapshot.
        const later = await server.ensureWorkspace(second);
        assert.match(later.systemPrompt, /You are the Acme assistant/);
    } finally {
        await server.stop();
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
    }
});

test("a restarted sidecar picks up the saved product name", async () => {
    saveGlobalConfig({ productName: "Beta" });
    const server = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => resolveConfig(),
    });
    const cwd = asWorkspaceId(await workspaceDir("restart"));
    try {
        const workspace = await server.ensureWorkspace(cwd);
        assert.match(workspace.systemPrompt, /You are the Beta assistant/);
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("two server instances keep their own product name", async () => {
    saveGlobalConfig({ productName: "Beta" });
    const acme = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => ({ ...resolveConfig(), productName: "Acme" }),
    });
    const beta = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => resolveConfig(),
    });
    const acmeCwd = asWorkspaceId(await workspaceDir("acme"));
    const betaCwd = asWorkspaceId(await workspaceDir("beta"));
    try {
        const acmeWorkspace = await acme.ensureWorkspace(acmeCwd);
        const betaWorkspace = await beta.ensureWorkspace(betaCwd);
        assert.match(acmeWorkspace.systemPrompt, /You are the Acme assistant/);
        assert.match(betaWorkspace.systemPrompt, /You are the Beta assistant/);
    } finally {
        await acme.stop();
        await beta.stop();
        await rm(acmeCwd, { recursive: true, force: true });
        await rm(betaCwd, { recursive: true, force: true });
    }
});

test("a standard child sends the startup name to the provider after settings.write", async (t) => {
    const systemPrompts: string[] = [];
    const provider = createServer(async (req, res) => {
        const { messages } = (await json(req)) as {
            messages: { role: string; content: string }[];
        };
        for (const message of messages) {
            if (message.role === "system" || message.role === "developer") {
                systemPrompts.push(message.content);
            }
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
            { delta: { role: "assistant", content: "pong" }, finish_reason: null },
            { delta: {}, finish_reason: "stop" },
        ]) {
            const chunk = {
                id: "test-completion",
                object: "chat.completion.chunk",
                model: "echo-1",
                choices: [{ index: 0, ...choice }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    saveGlobalConfig({
        productName: "Acme",
        defaultProvider: "custom:identity-stub",
        defaultModel: "echo-1",
        customProviders: [
            {
                id: "custom:identity-stub",
                name: "Identity test provider",
                api: "chatcomplete",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [{ id: "echo-1" }],
            },
        ],
        apiKeys: { "custom:identity-stub": "test-key" },
    });
    const config = resolveConfig();
    const cwd = asWorkspaceId(await workspaceDir("child"));
    const server = new SidecarServer({
        ...config,
        providerKeyStore: new ProviderKeyStore(config.apiKeys),
        resolveConfig,
    });
    try {
        await server.start(new NullTransport(), []);
        const workspace = await server.ensureWorkspace(cwd);
        const parentSessionId = asSessionId("parent");
        await workspace.createSession(parentSessionId);
        const saved = await server.dispatchRpc({
            id: "rename",
            method: "settings.write",
            params: { global: { productName: "Beta" } },
        });
        assert.ok(saved.ok, JSON.stringify(saved));
        assert.equal(resolveConfig().productName, "Beta");

        const child = await workspace.spawnSubagent({
            parentSessionId,
            parentToolCallId: "spawn",
            agentType: "reviewer",
            prompt: "Reply pong.",
            context: "independent",
            signal: AbortSignal.timeout(5000),
        });
        assert.equal(child.isError, false, child.resultText);
        assert.match(child.resultText, /pong/);
        assert.equal(systemPrompts.length, 1);
        assert.match(systemPrompts[0], /You are the Acme assistant/);
    } finally {
        await server.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});
