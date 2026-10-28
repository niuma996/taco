import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import { makeImSessionsRoot } from "../../src/channels/virtualWorkspace.ts";
import { tacoHome } from "../../src/config/tacoHome.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";

test("server-built IM workspaces retain routing and hide paths in parent and child prompts", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await server.start(new NullTransport(), [
        { channelId: "mock-scope", manifest: mockChannelManifest, config: {} },
    ]);
    const key = asWorkspaceId("im://mock-scope/peer/chat");
    try {
        const workspace = await server.ensureWorkspace(key);
        assert.equal(workspace.workspaceKey, key);
        assert.deepEqual(workspace.imRouting, {
            channelId: "mock-scope",
            peerId: "peer",
            chatId: "chat",
        });
        assert.equal(
            workspace.sessionCwd,
            join(makeImSessionsRoot(tacoHome(), "mock-scope"), "scratch"),
        );
        assert.deepEqual(workspace.sessionRegistry.getImChannelContext?.(), {
            type: mockChannelManifest.name,
            channelId: "mock-scope",
        });
        assert.ok(workspace.systemPrompt.includes("<channel_safety>"));
        assert.ok(!workspace.systemPrompt.includes("/Users/me/project/src/foo.ts"));
        assert.equal(
            (workspace.agentSpawner as unknown as { hideWorkspacePath: boolean }).hideWorkspacePath,
            true,
        );
        assert.ok(!workspace.tools.some((tool) => ["read", "write", "shell"].includes(tool.name)));
    } finally {
        await server.stop();
    }
});

test("changing IM execution policy preserves session storage and routes events with the virtual key", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const { InMemoryTransport } = await import("../_helpers/inMemoryTransport.ts");
    const transport = new InMemoryTransport();
    await server.start(transport, []);
    const key = asWorkspaceId("im://scope-storage/peer/chat");
    try {
        const original = await server.ensureWorkspace(key);
        const storage = original.sessionCwd;
        const created = await server.dispatchRpc({
            id: "create",
            method: "session.create",
            params: { workspace: key },
        });
        assert.ok(created.ok, JSON.stringify(created));
        const session = created.result as { sessionId: string };
        await server.setImChannelDefault("scope-storage", { executionDir: { mode: "per-chat" } });
        const rebuilt = await server.ensureWorkspace(key);
        assert.equal(rebuilt.sessionCwd, storage);
        assert.notEqual(rebuilt.executionCwd, storage);
        assert.equal(rebuilt.env.cwd, rebuilt.executionCwd);
        assert.equal(rebuilt.sessionEnv.cwd, storage);
        assert.ok((await rebuilt.listSessions()).some((item) => item.id === session.sessionId));
        rebuilt.emit("session.renamed", {
            sessionId: asSessionId(session.sessionId),
            name: "Retained",
        });
        const pushed = transport.sent.find(
            (frame) => "method" in frame && frame.method === "session.renamed",
        );
        assert.ok(pushed && "workspace" in pushed);
        assert.equal(pushed.workspace, key);
    } finally {
        await server.stop();
    }
});

test("MCP stdio defaults to IM execution cwd and respects an explicit server cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-mcp-scope-"));
    const explicit = join(root, "explicit");
    await mkdir(explicit);
    const script = join(root, "mcp.cjs");
    const defaultMarker = join(root, "default-cwd");
    const explicitMarker = join(root, "explicit-cwd");
    await writeFile(
        script,
        `
const {createInterface} = require("node:readline");
require("node:fs").writeFileSync(process.argv[2], process.cwd());
createInterface({input:process.stdin}).on("line", line => {
  const req=JSON.parse(line);
  if(req.id===undefined) return;
  const result=req.method==="initialize"
    ? {protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"scope",version:"1"}}
    : req.method==="tools/list" ? {tools:[]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result})+"\\n");
});
`,
    );
    const server = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        mcpServers: [
            {
                id: "default",
                transport: "stdio",
                command: process.execPath,
                args: [script, defaultMarker],
            },
            {
                id: "explicit",
                transport: "stdio",
                command: process.execPath,
                args: [script, explicitMarker],
                cwd: explicit,
            },
        ],
    });
    await server.start(new NullTransport(), []);
    try {
        await server.setImChannelDefault("scope-mcp", { executionDir: { mode: "per-chat" } });
        const workspace = await server.ensureWorkspace(asWorkspaceId("im://scope-mcp/peer/chat"));
        const { readFile, realpath } = await import("node:fs/promises");
        assert.equal(await readFile(defaultMarker, "utf8"), await realpath(workspace.executionCwd));
        assert.equal(await readFile(explicitMarker, "utf8"), await realpath(explicit));
    } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test("local workspace shorthand resolves paths without IM restrictions", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-local-scope-"));
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await server.start(new NullTransport(), []);
    try {
        const key = asWorkspaceId(`${root}/nested/..`);
        const workspace = await server.ensureWorkspace(key);
        assert.equal(workspace.scope.kind, "local");
        assert.equal(workspace.workspaceKey, key);
        assert.equal(workspace.sessionCwd, root);
        assert.equal(workspace.executionCwd, root);
        assert.equal(workspace.imRouting, undefined);
        assert.ok(workspace.tools.some((tool) => tool.name === "shell"));
        assert.ok(!workspace.systemPrompt.includes("<channel_safety>"));
    } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test("IM scope rejects virtual paths as filesystem directories and rejects malformed routes", async () => {
    const { createWorkspaceScope } = await import("../../src/workspace/workspaceScope.ts");
    const key = asWorkspaceId("im://scope/peer/chat");
    assert.throws(() => createWorkspaceScope(key), /requires filesystem/);
    assert.throws(() => createWorkspaceScope(key, "/tmp/storage", key), /requires filesystem/);
    assert.throws(
        () => createWorkspaceScope(asWorkspaceId("im://scope"), "/tmp/storage"),
        /invalid IM workspace/,
    );
});

test("IM storage keeps the lexical home path when the home is a symlink", {
    skip: process.platform === "win32" ? "symlink creation requires Windows privileges" : false,
}, async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "taco-scope-link-"));
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const previous = process.env.TACO_HOME;
    process.env.TACO_HOME = alias;
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await server.start(new NullTransport(), []);
    try {
        const key = asWorkspaceId("im://symlink-scope/peer/chat");
        const workspace = await server.ensureWorkspace(key);
        assert.equal(
            workspace.sessionCwd,
            join(alias, "sessions", "im", "symlink-scope", "scratch"),
        );
        const created = await server.dispatchRpc({
            id: "link-create",
            method: "session.create",
            params: { workspace: key },
        });
        assert.ok(created.ok, JSON.stringify(created));
        const session = created.result as { sessionId: string };
        await server.disposeWorkspace(key);
        const rebuilt = await server.ensureWorkspace(key);
        assert.equal(rebuilt.sessionCwd, workspace.sessionCwd);
        assert.ok((await rebuilt.listSessions()).some((item) => item.id === session.sessionId));
    } finally {
        await server.stop();
        if (previous === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
});
