import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asSessionId, asWorkspaceId, type RpcResponse } from "@taco-ai/protocol";
import { removeGitWorktree } from "../../src/git/gitService.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("worktree-availability");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });

async function fixture(
    run: (ctx: {
        root: string;
        path: string;
        sessionId: string;
        checkpointId: string;
        target: string;
        server: SidecarServer;
        rpc: (method: string, params: Record<string, unknown>) => Promise<RpcResponse>;
    }) => Promise<void>,
) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "taco-availability-")));
    const transport = new InMemoryTransport();
    const server = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        sessionsRoot: join(home, "sessions"),
    });
    let sequence = 0;
    const rpc = async (method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
        const id = `availability-${++sequence}`;
        transport.simulateRequest(JSON.stringify({ id, method, commandId: id, params }));
        for (;;) {
            const response = transport.sent.find((frame) => "id" in frame && frame.id === id);
            if (response) return response as RpcResponse;
            await transport.waitForPushCount(transport.sent.length + 1, 10_000);
        }
    };
    try {
        git(root, "init", "-b", "main");
        git(
            root,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        await server.start(transport, []);
        succeeded(
            await rpc("initialize", {
                protocolVersion: { major: 2, minor: 22 },
                clientCapabilities: { uiLocale: "en" },
            }),
        );
        const { path } = succeeded(
            await rpc("worktree.create", { workspace: root, name: "available", base: "head" }),
        ) as { path: string };
        const { sessionId } = succeeded(await rpc("session.create", { workspace: path })) as {
            sessionId: string;
        };
        const runtime = await server.ensureWorkspace(asWorkspaceId(path));
        const target = join(path, "saved.txt");
        await writeFile(target, "preserved checkpoint\n");
        assert.ok(runtime.checkpointStore);
        const checkpoint = await runtime.checkpointStore.create({
            sessionId,
            label: "deleted file",
            paths: [target],
        });
        assert.ok(checkpoint);
        await rm(target);
        await runtime.checkpointStore.finalize(checkpoint.id);
        await run({ root, path, sessionId, checkpointId: checkpoint.id, target, server, rpc });
    } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
    }
}
function succeeded(response: RpcResponse): unknown {
    assert.ok(response.ok, JSON.stringify(response));
    return response.result;
}
function unavailable(response: RpcResponse): void {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!response.ok) assert.equal(response.error.code, "invalid_state", JSON.stringify(response));
}
const agent = {
    scope: "workspace",
    agentType: "availability-helper",
    description: "Test agent",
    systemPrompt: "Test agent",
    maxTurns: 1,
};

test("removed checkout rejects local agent writes but retains history and global agent editing", async () => {
    await fixture(async ({ root, path, sessionId, rpc }) => {
        succeeded(await rpc("worktree.remove", { workspace: root, path }));
        for (const method of ["session.list", "session.history", "checkpoints.list"]) {
            succeeded(await rpc(method, { workspace: path, sessionId }));
        }
        unavailable(await rpc("agents.write", { workspace: path, ...agent }));
        assert.equal(existsSync(path), false);
        succeeded(await rpc("agents.write", { workspace: path, ...agent, scope: "global" }));
        succeeded(
            await rpc("agents.delete", {
                workspace: path,
                agentType: agent.agentType,
                scope: "global",
            }),
        );
        assert.equal(existsSync(path), false);
    });
});

test("implicit task and plan reads cannot attach a removed checkout", async () => {
    await fixture(async ({ root, path, sessionId, server, rpc }) => {
        succeeded(await rpc("worktree.remove", { workspace: root, path }));
        for (const method of [
            "session.tasks.get",
            "session.planState.get",
            "session.taskHistory.get",
        ]) {
            unavailable(await rpc(method, { workspace: path, sessionId, listId: "unused" }));
        }
        assert.equal(
            (await server.ensureWorkspace(asWorkspaceId(path))).sessionRegistry.attachedCount,
            0,
        );
        assert.equal(existsSync(path), false);
    });
});

for (const cold of [false, true]) {
    test(`recreated ordinary directory stays unavailable (${cold ? "cold" : "cached"} runtime)`, async () => {
        await fixture(async ({ root, path, sessionId, checkpointId, target, server, rpc }) => {
            succeeded(await rpc("worktree.remove", { workspace: root, path }));
            succeeded(await rpc("session.list", { workspace: path }));
            await mkdir(join(path, ".taco", "agents"), { recursive: true });
            await writeFile(
                join(path, ".taco", "agents", "availability-helper.md"),
                "---\nname: availability-helper\ndescription: Test\n---\nTest\n",
            );
            if (cold) await server.disposeWorkspace(asWorkspaceId(path));
            else await server.reloadAgents();
            for (const [method, params] of [
                ["session.create", {}],
                ["session.attach", { sessionId }],
                ["checkpoints.restore", { sessionId, checkpointId }],
                ["agents.write", { ...agent, agentType: "another-helper" }],
                ["agents.delete", { agentType: agent.agentType, scope: "workspace" }],
                ["agents.delete", { agentType: agent.agentType }],
            ] as const)
                unavailable(await rpc(method, { workspace: path, ...params }));
            const runtime = await server.ensureWorkspace(asWorkspaceId(path));
            await assert.rejects(runtime.attach(asSessionId(sessionId)), /工作树目录/);
            await assert.rejects(runtime.createSession(asSessionId("unavailable")), /工作树目录/);
            await assert.rejects(
                runtime.restoreCheckpoint(checkpointId, asSessionId(sessionId)),
                /工作树目录/,
            );
            assert.equal(runtime.sessionRegistry.attachedCount, 0);
            assert.equal(existsSync(target), false);
            assert.match(
                await readFile(join(path, ".taco", "agents", "availability-helper.md"), "utf8"),
                /Test/,
            );
        });
    });
}

test("live linked checkout still attaches, restores files and edits local agents", async () => {
    await fixture(async ({ path, sessionId, checkpointId, target, rpc }) => {
        succeeded(await rpc("session.attach", { workspace: path, sessionId }));
        succeeded(await rpc("checkpoints.restore", { workspace: path, sessionId, checkpointId }));
        assert.equal(await readFile(target, "utf8"), "preserved checkpoint\n");
        succeeded(await rpc("agents.write", { workspace: path, ...agent }));
        succeeded(await rpc("agents.delete", { workspace: path, agentType: agent.agentType }));
    });
});

test("runtime validation is optional and injected policy precedes execution side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-availability-runtime-"));
    const plain = new WorkspaceRuntime({
        cwd: asWorkspaceId(root),
        providerKeyStore: new ProviderKeyStore({}),
    });
    let calls = 0;
    const denied = new Error("execution denied");
    const guarded = new WorkspaceRuntime({
        cwd: asWorkspaceId(root),
        providerKeyStore: new ProviderKeyStore({}),
        validateExecution: async () => {
            calls++;
            throw denied;
        },
    });
    try {
        await plain.assertExecutionAvailable();
        await plain.createSession(asSessionId("plain-session"));
        await plain.attach(asSessionId("plain-session"));
        await assert.rejects(
            guarded.createSession(asSessionId("guarded-session")),
            (error) => error === denied,
        );
        await assert.rejects(
            guarded.attach(asSessionId("guarded-session")),
            (error) => error === denied,
        );
        await assert.rejects(
            guarded.restoreCheckpoint("unknown", asSessionId("guarded-session")),
            (error) => error === denied,
        );
        assert.equal(calls, 3);
        assert.equal(guarded.sessionRegistry.attachedCount, 0);
    } finally {
        await plain.dispose();
        await guarded.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test("a live runtime rejects its checkout replaced by an ordinary directory", async () => {
    await fixture(async ({ root, path, sessionId, server, rpc }) => {
        await server.ensureWorkspace(asWorkspaceId(path));
        git(root, "worktree", "remove", path);
        await mkdir(path);
        unavailable(await rpc("session.attach", { workspace: path, sessionId }));
        unavailable(await rpc("agents.write", { workspace: path, ...agent }));
        assert.equal(existsSync(join(path, ".taco")), false);
    });
});

test("failed removal preparation leaves a valid checkout executable, including cold reopen", async () => {
    await fixture(async ({ root, path, sessionId, server, rpc }) => {
        await assert.rejects(
            removeGitWorktree(root, path, {
                beforeRemove: async () => {
                    throw new Error("preparation failed");
                },
            }),
            /preparation failed/,
        );
        succeeded(await rpc("session.attach", { workspace: path, sessionId }));
        succeeded(await rpc("session.detach", { workspace: path, sessionId }));
        await server.disposeWorkspace(asWorkspaceId(path));
        succeeded(await rpc("session.attach", { workspace: path, sessionId }));
        succeeded(await rpc("session.detach", { workspace: path, sessionId }));
        succeeded(await rpc("worktree.remove", { workspace: root, path }));
        assert.equal(existsSync(path), false);
    });
});

test("already attached session refuses execution after external checkout removal", async () => {
    await fixture(async ({ root, path, sessionId, rpc }) => {
        succeeded(await rpc("session.attach", { workspace: path, sessionId }));
        git(root, "worktree", "remove", path);
        for (const method of [
            "session.prompt",
            "session.tasks.get",
            "session.planState.get",
            "session.submitAnswers",
            "session.steer",
            "session.followUp",
            "session.compact",
        ]) {
            unavailable(
                await rpc(method, {
                    workspace: path,
                    sessionId,
                    text: "do not run",
                    toolCallId: "unused",
                    answers: {},
                }),
            );
        }
        assert.equal(existsSync(path), false);
    });
});
