/** Consolidated from 3 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { AgentsWriteParams } from "@taco-ai/protocol";
import { asSessionId } from "@taco-ai/protocol";
import { parseAgentMarkdown } from "../../../src/agents/loadAgents.ts";
import type { AgentDefinition } from "../../../src/agents/types.ts";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { PermissionBroker } from "../../../src/permissions/permissionBroker.ts";
import type { ServerRpcSurface } from "../../../src/runtime/serverRpcSurface.ts";
import {
    AgentWriteError,
    agentScopeOf,
    deleteUserAgent,
    isEditableAgent,
    userAgentsDir,
    writeUserAgent,
} from "../../../src/server/handlers/agentsWrite.ts";
import { ensureAttached, requireAttached } from "../../../src/server/handlers/attachGuard.ts";
import { RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { ServerRegistry } from "../../../src/server/serverRegistry.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("agents.write", () => {
    /**
     * agents.write / agents.delete file ops against a temp $TACO_HOME.
     * No RPC server — the handlers are thin wrappers over these functions.
     */

    function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
        return {
            agentType: "x",
            description: "d",
            systemPrompt: "body",
            source: "user",
            filePath: join(userAgentsDir(), "x.md"),
            ...over,
        };
    }

    function params(over: Partial<AgentsWriteParams> = {}): AgentsWriteParams {
        return {
            workspace: "/w" as AgentsWriteParams["workspace"],
            agentType: "my-cc",
            description: "reads things",
            runtime: "claude-code",
            maxTurns: 30,
            systemPrompt: "You read files.",
            ...over,
        };
    }

    describe("agentsWrite", () => {
        let home: string;
        let prevHome: string | undefined;

        beforeEach(() => {
            home = mkdtempSync(join(tmpdir(), "taco-agents-"));
            prevHome = process.env.TACO_HOME;
            process.env.TACO_HOME = home;
        });
        afterEach(() => {
            if (prevHome === undefined) delete process.env.TACO_HOME;
            else process.env.TACO_HOME = prevHome;
            rmSync(home, { recursive: true, force: true });
        });

        it("creates <agentType>.md under $TACO_HOME/agents with parseable frontmatter", async () => {
            await writeUserAgent(
                params({ description: "reads: things", whenToUse: "for reads" }),
                [],
            );
            const files = readdirSync(userAgentsDir());
            assert.deepEqual(files, ["my-cc.md"]);
            const text = readFileSync(join(userAgentsDir(), "my-cc.md"), "utf-8");
            assert.match(text, /runtime: claude-code/);
            assert.match(text, /maxTurns: 30/);
            // Round-trip through the real loader's parser.
            const parsed = parseAgentMarkdown(text, "x", "user");
            assert.equal(parsed?.agentType, "my-cc");
            assert.equal(parsed?.description, "reads: things");
            assert.equal(parsed?.runtime, "claude-code");
            assert.equal(parsed?.systemPrompt, "You read files.");
        });

        it("writes a standard agent with no runtime line, so it parses as the default", async () => {
            await writeUserAgent(params({ agentType: "plain", runtime: undefined }), []);
            const text = readFileSync(join(userAgentsDir(), "plain.md"), "utf-8");
            assert.doesNotMatch(text, /runtime:/);
            assert.equal(parseAgentMarkdown(text, "x", "user")?.runtime, undefined);

            await writeUserAgent(params({ agentType: "plain2", runtime: "standard" }), []);
            assert.doesNotMatch(
                readFileSync(join(userAgentsDir(), "plain2.md"), "utf-8"),
                /runtime:/,
            );
        });

        it("round-trips claude-code tools and permission mode; defaults stay implicit", async () => {
            await writeUserAgent(
                params({
                    agentType: "cc-a",
                    tools: ["Read", "Edit"],
                    permissionMode: "acceptEdits",
                }),
                [],
            );
            const a = parseAgentMarkdown(
                readFileSync(join(userAgentsDir(), "cc-a.md"), "utf-8"),
                "x",
                "user",
            );
            assert.deepEqual(a?.tools, ["Read", "Edit"]);
            assert.equal(a?.permissionMode, "acceptEdits");

            await writeUserAgent(
                params({ agentType: "cc-b", tools: [], permissionMode: "auto" }),
                [],
            );
            const text = readFileSync(join(userAgentsDir(), "cc-b.md"), "utf-8");
            assert.doesNotMatch(text, /tools:|permissionMode:/);
        });

        it("never writes Claude Code settings for a standard agent", async () => {
            await writeUserAgent(
                params({
                    agentType: "std",
                    runtime: "standard",
                    tools: ["Read"],
                    permissionMode: "bypassPermissions",
                }),
                [],
            );
            const text = readFileSync(join(userAgentsDir(), "std.md"), "utf-8");
            assert.doesNotMatch(text, /tools:|permissionMode:/);
        });

        it("rejects AskUserQuestion, which the runner always blocks", async () => {
            await assert.rejects(
                writeUserAgent(params({ tools: ["Read", "AskUserQuestion"] }), []),
                /AskUserQuestion is not available/,
            );
        });

        it("rejects tool names that are not plain identifiers", async () => {
            await assert.rejects(
                writeUserAgent(params({ tools: ["Read", "x\nrm"] }), []),
                AgentWriteError,
            );
        });

        it("rejects names that would escape the agents dir or break tooling", async () => {
            for (const bad of ["../evil", "My-Agent", "a b", "x".repeat(70)]) {
                await assert.rejects(
                    writeUserAgent(params({ agentType: bad }), []),
                    AgentWriteError,
                );
            }
            assert.ok(!readdirSync(home).includes("agents"));
        });

        it("rejects a create whose agentType already exists in any source", async () => {
            await assert.rejects(
                writeUserAgent(params({ agentType: "explorer" }), [
                    def({
                        agentType: "explorer",
                        source: "builtin",
                        filePath: "/pkg/builtin/explorer.md",
                    }),
                ]),
                /already exists/,
            );
        });

        it("rejects editing a definition outside $TACO_HOME/agents", async () => {
            const ro = def({ agentType: "ro", filePath: "/Users/x/.claude/agents/ro.md" });
            await assert.rejects(
                writeUserAgent(params({ agentType: "ro", previousAgentType: "ro" }), [ro]),
                /not editable/,
            );
            await assert.rejects(deleteUserAgent("ro", [ro]), /not editable/);
        });

        it("renames on edit: writes the new file and removes the old one", async () => {
            await writeUserAgent(params({ agentType: "old-name" }), []);
            await writeUserAgent(
                params({ agentType: "new-name", previousAgentType: "old-name", description: "v2" }),
                [def({ agentType: "old-name" })],
            );
            assert.deepEqual(readdirSync(userAgentsDir()), ["new-name.md"]);
            assert.match(
                readFileSync(join(userAgentsDir(), "new-name.md"), "utf-8"),
                /name: "new-name"/,
            );
        });

        it("rejects a rename onto an existing agentType", async () => {
            await writeUserAgent(params({ agentType: "taken" }), []);
            await writeUserAgent(params({ agentType: "mine" }), []);
            await assert.rejects(
                writeUserAgent(params({ agentType: "taken", previousAgentType: "mine" }), [
                    def({ agentType: "mine" }),
                    def({ agentType: "taken" }),
                ]),
                /already exists/,
            );
        });

        it("deletes only editable definitions", async () => {
            await writeUserAgent(params(), []);
            await deleteUserAgent("my-cc", [def({ agentType: "my-cc" })]);
            assert.equal(readdirSync(userAgentsDir()).includes("my-cc.md"), false);
            await assert.rejects(deleteUserAgent("ghost", []), /not found/);
        });

        it("并发写同一个 agent 不互相踩临时文件", async () => {
            // The write goes to `<target>.tmp-*` then renames. If the temp name were
            // derived from the pid alone, two writes in one process would share it:
            // one rename would win and the other would fail with ENOENT.
            await Promise.all([
                writeUserAgent(params({ agentType: "race", description: "v1" }), []),
                writeUserAgent(params({ agentType: "race", description: "v2" }), []),
            ]);
            const parsed = parseAgentMarkdown(
                readFileSync(join(userAgentsDir(), "race.md"), "utf-8"),
                "race",
                "user",
            );
            assert.ok(["v1", "v2"].includes(parsed?.description ?? ""));
            assert.deepEqual(
                readdirSync(userAgentsDir()).filter((f) => f.includes(".tmp-")),
                [],
                "no temp file may survive the rename",
            );
        });

        it("marks only $TACO_HOME/agents definitions as editable", () => {
            assert.equal(isEditableAgent(def()), true);
            assert.equal(isEditableAgent(def({ filePath: "/pkg/builtin/explorer.md" })), false);
            assert.equal(isEditableAgent(def({ filePath: `${userAgentsDir()}-evil/x.md` })), false);
        });
    });

    describe("agentsWrite scope", () => {
        let home: string;
        let project: string;
        let prevHome: string | undefined;

        beforeEach(() => {
            home = mkdtempSync(join(tmpdir(), "taco-agents-home-"));
            project = mkdtempSync(join(tmpdir(), "taco-agents-project-"));
            prevHome = process.env.TACO_HOME;
            process.env.TACO_HOME = home;
        });
        afterEach(() => {
            if (prevHome === undefined) delete process.env.TACO_HOME;
            else process.env.TACO_HOME = prevHome;
            rmSync(home, { recursive: true, force: true });
            rmSync(project, { recursive: true, force: true });
        });

        const projectAgentsDir = () => join(project, ".taco", "agents");
        const ctx = () => ({ workspaceDir: project });
        const inProject = (agentType: string) =>
            def({ agentType, filePath: join(projectAgentsDir(), `${agentType}.md`) });

        it("defaults to the global directory", async () => {
            await writeUserAgent(params(), [], ctx());
            assert.deepEqual(readdirSync(userAgentsDir()), ["my-cc.md"]);
            assert.equal(existsSync(projectAgentsDir()), false);
        });

        it("writes a workspace-scoped agent under <workspace>/.taco/agents", async () => {
            await writeUserAgent(params({ scope: "workspace" }), [], ctx());
            assert.deepEqual(readdirSync(projectAgentsDir()), ["my-cc.md"]);
            assert.equal(existsSync(userAgentsDir()), false);
        });

        it("refuses a workspace scope when the conversation has no project directory", async () => {
            await assert.rejects(
                writeUserAgent(params({ scope: "workspace" }), [], {}),
                /project directory/,
            );
            assert.equal(existsSync(projectAgentsDir()), false);
        });

        it("lets a workspace agent shadow a global one but not the reverse", async () => {
            const global = def({ agentType: "shared" });
            await writeUserAgent(
                params({ agentType: "shared", scope: "workspace" }),
                [global],
                ctx(),
            );
            assert.deepEqual(readdirSync(projectAgentsDir()), ["shared.md"]);

            await assert.rejects(
                writeUserAgent(
                    params({ agentType: "shared", scope: "global" }),
                    [inProject("shared")],
                    ctx(),
                ),
                /already exists/,
            );
        });

        it("still rejects shadowing a builtin or a hand-managed directory", async () => {
            for (const filePath of [
                "/pkg/builtin/explorer.md",
                "/Users/x/.claude/agents/explorer.md",
            ]) {
                await assert.rejects(
                    writeUserAgent(
                        params({ agentType: "explorer", scope: "workspace" }),
                        [def({ agentType: "explorer", filePath })],
                        ctx(),
                    ),
                    /already exists/,
                );
            }
        });

        it("rejects a create that would overwrite a file the catalog does not show", async () => {
            // The global copy is hidden behind a workspace one of the same name.
            await writeUserAgent(params({ agentType: "hidden", scope: "global" }), [], ctx());
            await writeUserAgent(
                params({ agentType: "hidden", scope: "workspace" }),
                [def({ agentType: "hidden" })],
                ctx(),
            );
            await assert.rejects(
                writeUserAgent(
                    params({ agentType: "hidden", scope: "global" }),
                    [inProject("hidden")],
                    ctx(),
                ),
                /already exists/,
            );
        });

        it("moves a definition between scopes: writes the new file, removes the old", async () => {
            await writeUserAgent(params({ agentType: "mover" }), [], ctx());
            await writeUserAgent(
                params({ agentType: "mover", scope: "workspace", previousAgentType: "mover" }),
                [def({ agentType: "mover" })],
                ctx(),
            );
            assert.deepEqual(readdirSync(projectAgentsDir()), ["mover.md"]);
            assert.deepEqual(readdirSync(userAgentsDir()), []);
        });

        it("edits in place when scope is omitted", async () => {
            await writeUserAgent(params({ agentType: "stay", scope: "workspace" }), [], ctx());
            await writeUserAgent(
                params({ agentType: "stay", previousAgentType: "stay", description: "v2" }),
                [inProject("stay")],
                ctx(),
            );
            assert.match(readFileSync(join(projectAgentsDir(), "stay.md"), "utf-8"), /v2/);
            assert.equal(existsSync(userAgentsDir()), false);
        });

        it("deletes from the scope the definition lives in", async () => {
            await writeUserAgent(params({ agentType: "gone", scope: "workspace" }), [], ctx());
            await writeUserAgent(params({ agentType: "gone", scope: "global" }), [], ctx()).catch(
                () => undefined,
            );
            await deleteUserAgent("gone", [inProject("gone")], ctx());
            assert.equal(existsSync(join(projectAgentsDir(), "gone.md")), false);
        });

        it("classifies scope by file location and ignores the project dir without a context", () => {
            assert.equal(agentScopeOf(def(), ctx()), "global");
            assert.equal(agentScopeOf(inProject("p"), ctx()), "workspace");
            assert.equal(agentScopeOf(inProject("p")), undefined);
            assert.equal(
                agentScopeOf(def({ filePath: join(project, "elsewhere", "x.md") }), ctx()),
                undefined,
            );
            assert.equal(
                agentScopeOf(def({ filePath: `${projectAgentsDir()}-evil/x.md` }), ctx()),
                undefined,
            );
        });
    });

    describe("agentsWrite claude-code cwd", () => {
        let home: string;
        let workspaceDir: string;
        let associated: string;
        let outside: string;
        let prevHome: string | undefined;

        beforeEach(() => {
            home = mkdtempSync(join(tmpdir(), "taco-agents-cwd-home-"));
            workspaceDir = mkdtempSync(join(tmpdir(), "taco-agents-cwd-ws-"));
            associated = mkdtempSync(join(tmpdir(), "taco-agents-cwd-assoc-"));
            outside = mkdtempSync(join(tmpdir(), "taco-agents-cwd-out-"));
            prevHome = process.env.TACO_HOME;
            process.env.TACO_HOME = home;
        });
        afterEach(() => {
            if (prevHome === undefined) delete process.env.TACO_HOME;
            else process.env.TACO_HOME = prevHome;
            for (const d of [home, workspaceDir, associated, outside]) {
                rmSync(d, { recursive: true, force: true });
            }
        });

        const ctx = () => ({ workspaceDir, allowedCwds: [workspaceDir, associated] });
        const read = (name: string) => readFileSync(join(userAgentsDir(), `${name}.md`), "utf-8");

        it("writes the chosen directory and the loader reads it back", async () => {
            await writeUserAgent(params({ agentType: "fixed", cwd: associated }), [], ctx());
            const parsed = parseAgentMarkdown(read("fixed"), "x", "user");
            assert.equal(parsed?.cwd, associated);
        });

        it("accepts the workspace directory and rejects anything outside the choices", async () => {
            await writeUserAgent(params({ agentType: "home", cwd: workspaceDir }), [], ctx());
            assert.match(read("home"), /cwd: /);
            await assert.rejects(
                writeUserAgent(params({ agentType: "out", cwd: outside }), [], ctx()),
                /workspace directory or one of its associated directories/,
            );
            await assert.rejects(
                writeUserAgent(
                    params({ agentType: "sub", cwd: join(workspaceDir, "x") }),
                    [],
                    ctx(),
                ),
                /not an existing directory/,
            );
            await assert.rejects(
                writeUserAgent(params({ agentType: "rel", cwd: "relative/dir" }), [], ctx()),
                /absolute path/,
            );
        });

        it("keeps an unchanged directory that is no longer a choice here", async () => {
            // Fixed from another workspace: editing it here must not force a move.
            const existing = def({ agentType: "keep", runtime: "claude-code", cwd: outside });
            await writeUserAgent(
                params({
                    agentType: "keep",
                    cwd: outside,
                    previousAgentType: "keep",
                    description: "v2",
                }),
                [existing],
                ctx(),
            );
            assert.match(read("keep"), /v2/);
            await assert.rejects(
                writeUserAgent(
                    params({
                        agentType: "keep",
                        cwd: join(outside, ".."),
                        previousAgentType: "keep",
                    }),
                    [def({ agentType: "keep", runtime: "claude-code", cwd: outside })],
                    ctx(),
                ),
                /workspace directory or one of its associated directories/,
            );
        });

        it("never writes a directory for a standard agent", async () => {
            await writeUserAgent(
                params({ agentType: "std", runtime: "standard", cwd: associated }),
                [],
                ctx(),
            );
            assert.doesNotMatch(read("std"), /cwd:/);
        });

        it("omits the line when no directory is given", async () => {
            await writeUserAgent(params({ agentType: "nodir" }), [], ctx());
            assert.doesNotMatch(read("nodir"), /cwd:/);
            assert.equal(parseAgentMarkdown(read("nodir"), "x", "user")?.cwd, undefined);
        });
    });

    describe("agents.write/delete server fan-out", () => {
        /** The fields the agents handlers read off a workspace. */
        const stubWorkspace = (agents: AgentDefinition[]) => ({
            agents,
            executionCwd: "/w",
            imRouting: undefined,
            associatedRoots: () => [],
        });

        useTempTacoHome("agents-fanout");

        it("reloads every registered server after writing a definition", async () => {
            registerBuiltinMethods();
            const calls = [0, 0, 0];
            const servers = calls.map(
                (_, i) =>
                    ({
                        async reloadAgents() {
                            calls[i] = (calls[i] ?? 0) + 1;
                        },
                    }) as unknown as ServerRpcSurface,
            );
            const registry = new ServerRegistry();
            servers.forEach((server) => {
                registry.add(server);
            });
            const workspace = stubWorkspace([]);
            await callMethod("agents.write", {
                server: servers[0],
                serverRegistry: registry,
                params: params({ agentType: "fanout" }),
                workspace,
            });
            assert.deepEqual(calls, [1, 1, 1]);
        });

        it("reloads every server after deletion and isolates reload failures", async () => {
            registerBuiltinMethods();
            const calls = [0, 0, 0];
            const servers = calls.map(
                (_, i) =>
                    ({
                        async reloadAgents() {
                            calls[i] = (calls[i] ?? 0) + 1;
                            if (i === 1) throw new Error("stale server");
                        },
                    }) as unknown as ServerRpcSurface,
            );
            const registry = new ServerRegistry();
            servers.forEach((server) => {
                registry.add(server);
            });
            await writeUserAgent(params({ agentType: "to-delete" }), []);

            await callMethod("agents.delete", {
                server: servers[0],
                serverRegistry: registry,
                params: { workspace: "/w", agentType: "to-delete" },
                workspace: stubWorkspace([def({ agentType: "to-delete" })]),
            });

            assert.deepEqual(calls, [1, 1, 1]);
            assert.equal(readdirSync(userAgentsDir()).includes("to-delete.md"), false);
        });

        it("falls back to reloading the request server without a registry", async () => {
            registerBuiltinMethods();
            let calls = 0;
            const server = {
                async reloadAgents() {
                    calls++;
                },
            } as unknown as ServerRpcSurface;
            await callMethod("agents.write", {
                server,
                params: params({ agentType: "single" }),
                workspace: stubWorkspace([]),
            });
            assert.equal(calls, 1);
        });
    });
});

describe("attachGuard", () => {
    /**
     * attachGuard — ensureAttached / requireAttached failure semantics.
     *
     * ensureAttached must propagate whatever workspace.attach throws (so the
     * dispatcher's normalizeError surfaces it as an RPC error). requireAttached
     * must throw RpcHandlerError("invalid_state") for a missing attached session.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/attachGuard.test.ts
     */

    describe("requireAttached", () => {
        it("throws invalid_state when no attached session exists", () => {
            const workspace = {
                getAttached: () => undefined,
            };
            assert.throws(
                () => requireAttached(workspace as never, asSessionId("sess-1")),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    e.code === "invalid_state" &&
                    /not attached/i.test(e.message),
            );
        });

        it("returns the attached session when one exists", () => {
            const attached = { session: "stub" };
            const workspace = {
                getAttached: () => attached,
            };
            assert.equal(requireAttached(workspace as never, asSessionId("sess-1")), attached);
        });
    });

    describe("ensureAttached", () => {
        it("attaches lazily when no attached session exists", async () => {
            let attached: { id: string } | undefined;
            const workspace = {
                getAttached: () => attached,
                async attach(id: string) {
                    attached = { id };
                    return attached;
                },
            };
            const result = await ensureAttached(workspace as never, asSessionId("sess-2"));
            assert.deepEqual(result, { id: "sess-2" });
        });

        it("returns the existing attached session without re-attaching", async () => {
            let attachCalls = 0;
            const existing = { id: "sess-3" };
            const workspace = {
                getAttached: () => existing,
                async attach() {
                    attachCalls++;
                    return existing;
                },
            };
            const result = await ensureAttached(workspace as never, asSessionId("sess-3"));
            assert.equal(result, existing);
            assert.equal(attachCalls, 0, "attach must not be called when already attached");
        });

        it("propagates workspace.attach failures as-is", async () => {
            const workspace = {
                getAttached: () => undefined,
                async attach() {
                    throw new Error("disk full");
                },
            };
            await assert.rejects(
                () => ensureAttached(workspace as never, asSessionId("sess-4")),
                (e: unknown) => e instanceof Error && e.message === "disk full",
            );
        });
    });
});

describe("commandPermission.persistence", () => {
    useTempTacoHome("permission-persistence");
    before(registerBuiltinMethods);
    it("ignores forged persistent approval for unsupported syntax", async () => {
        saveGlobalConfig({ commandPermissions: { mode: "auto", allow: [], deny: [] } });
        const broker = new PermissionBroker(
            () => readGlobalConfig().commandPermissions ?? { mode: "ask", allow: [], deny: [] },
        );
        const requested = new Promise<string>((resolve) =>
            broker.once("requested", (request) => resolve(request.requestId)),
        );
        const pending = broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "echo $(pwd)",
        });
        await callMethod("commandPermission.resolve", {
            workspace: { permissionBroker: broker },
            params: {
                workspace: "/tmp/ws",
                requestId: await requested,
                approved: true,
                scope: "global",
            },
        });
        assert.equal((await pending).scope, "once");
        assert.deepEqual(readGlobalConfig().commandPermissions?.allow, []);
    });
    it("persists a static path approval without replacing newer rules", async () => {
        saveGlobalConfig({ commandPermissions: { mode: "ask", allow: [], deny: [] } });
        const broker = new PermissionBroker(
            () => readGlobalConfig().commandPermissions ?? { mode: "ask", allow: [], deny: [] },
        );
        const requested = new Promise<string>((resolve) =>
            broker.once("requested", (request) => resolve(request.requestId)),
        );
        const command = "./gradlew build -x test";
        const pending = broker.evaluateAndRequest({ sessionId: "s1", toolCallId: "t1", command });
        const requestId = await requested;
        saveGlobalConfig({
            commandPermissionsEdit: { addAllow: ["pnpm test"], addDeny: ["git push *"] },
        });
        await callMethod("commandPermission.resolve", {
            workspace: { permissionBroker: broker },
            params: { workspace: "/tmp/ws", requestId, approved: true, scope: "global" },
        });
        assert.equal((await pending).approved, true);
        assert.deepEqual(readGlobalConfig().commandPermissions?.allow, ["pnpm test", command]);
        assert.deepEqual(readGlobalConfig().commandPermissions?.deny, ["git push *"]);
        assert.equal(
            (await broker.evaluateAndRequest({ sessionId: "s1", toolCallId: "t2", command }))
                .approved,
            true,
        );
    });
});
