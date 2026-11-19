import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { AgentMessage, Session } from "../../src/runtime/pi/types.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import {
    readClaudeCodeState,
    writeClaudeCodeState,
} from "../../src/runtime/subagent/claudeCode/claudeCodeState.ts";
import {
    CODEX_SDK_VERSION,
    type CodexClientOptions,
    type CodexSdkModule,
    type CodexThread,
    type CodexThreadOptions,
    type LoadedCodexSdk,
} from "../../src/runtime/subagent/codex/codexSdk.ts";
import { readCodexState, writeCodexState } from "../../src/runtime/subagent/codex/codexState.ts";
import { createClaudeCodeEngine } from "../../src/runtime/subagent/engines/claudeCodeEngine.ts";
import { createCodexEngine } from "../../src/runtime/subagent/engines/codexEngine.ts";
import type {
    EngineRunRequest,
    NativeEngineDeps,
} from "../../src/runtime/subagent/engines/types.ts";

const childId = asSessionId("native-engine-child");
const def: AgentDefinition = {
    agentType: "native-agent",
    description: "native test agent",
    systemPrompt: "review carefully",
    source: "user",
    filePath: "/agents/native-agent.md",
};

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
    return {
        agentType: def.agentType,
        childSessionId: childId,
        parentSessionId: asSessionId("native-engine-parent"),
        parentToolCallId: "native-call",
        abortController: new AbortController(),
        prompt: "first question",
        tools: [],
        claudeCodeTools: [],
        codexTools: [],
        ...overrides,
    };
}

async function fixture(t: TestContext) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "taco-native-engines-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const values = new Map<object, unknown>();
    const session = {
        getValue: async (ref: object) => ({ value: values.get(ref) }),
        setValue: async (ref: object, value: unknown) => {
            values.set(ref, value);
        },
    } as unknown as Session;
    const writes: { id: SessionId; messages: AgentMessage[] }[] = [];
    const running: { id: SessionId; runId?: string }[] = [];
    const inputs: Parameters<NativeEngineDeps["conversation"]["setInput"]>[] = [];
    const deps: NativeEngineDeps = {
        registry: {
            withSession: async (id, read) => {
                assert.equal(id, childId);
                return read(session);
            },
        },
        executionCwd: () => cwd,
        conversation: {
            setInput: (...args) => {
                inputs.push(args);
            },
            markRunning: (id, runId) => {
                running.push({ id, runId });
            },
            chat: async () => {
                throw new Error("unexpected chat");
            },
            list: async () => [],
        },
        appendMessages: async (id, messages) => {
            writes.push({ id, messages });
        },
    };
    const claudeOptions: SdkQueryOptions[] = [];
    const claudeSdk: ClaudeAgentSdk = {
        query({ options }) {
            claudeOptions.push(options);
            return (async function* (): AsyncGenerator<SdkMessage> {
                yield { type: "system", subtype: "init", session_id: "claude-native-1" };
                yield {
                    type: "assistant",
                    message: { id: "answer", content: [{ type: "text", text: "Claude answer" }] },
                };
                yield {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    num_turns: 1,
                };
            })();
        },
    };
    const clients: CodexClientOptions[] = [];
    const starts: CodexThreadOptions[] = [];
    const resumes: { id: string; options?: CodexThreadOptions }[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    let streamFailure: Error | undefined;
    const thread = (id: string): CodexThread => ({
        id,
        async runStreamed(_input, options) {
            signals.push(options?.signal);
            return {
                events: (async function* () {
                    if (streamFailure) throw streamFailure;
                    yield { type: "thread.started", thread_id: id };
                    yield {
                        type: "item.completed",
                        item: { id: "answer", type: "agent_message", text: "Codex answer" },
                    };
                    yield { type: "turn.completed" };
                })(),
            };
        },
    });
    const codexSdk: CodexSdkModule = {
        Codex: class {
            constructor(options: CodexClientOptions = {}) {
                clients.push(options);
            }
            startThread(options: CodexThreadOptions = {}) {
                starts.push(options);
                return thread("codex-native-1");
            }
            resumeThread(id: string, options?: CodexThreadOptions) {
                resumes.push({ id, options });
                return thread(id);
            }
        },
    };
    const loaded = (module = codexSdk): LoadedCodexSdk => ({
        module,
        version: CODEX_SDK_VERSION,
        packageRoot: join(root, "sdk"),
        entryPath: join(root, "sdk", "dist", "index.js"),
    });
    let loads = 0;
    const claudeDeps = {
        ...deps,
        getAllowedCwds: () => [cwd],
        loadClaudeCodeSdk: async () => claudeSdk,
        findClaudeCode: () => join(root, "claude"),
    };
    const codexDeps = {
        ...deps,
        getAllowedCwds: () => [cwd],
        loadCodexSdkForRun: async () => {
            loads++;
            return loaded();
        },
    };
    return {
        root,
        cwd,
        deps,
        session,
        writes,
        running,
        inputs,
        claudeOptions,
        claudeDeps,
        codexDeps,
        clients,
        starts,
        resumes,
        signals,
        loaded,
        loadCount: () => loads,
        failStream: () => {
            streamFailure = new Error("stream failed");
        },
    };
}

describe("Claude Code engine adapter", () => {
    it("advertises nextTurn delivery and validates fixed and default cwd", async (t) => {
        const f = await fixture(t);
        const engine = createClaudeCodeEngine(f.claudeDeps);
        assert.equal(engine.runtime, "claude-code");
        assert.deepEqual(engine.capabilities, {
            forkContext: false,
            delivery: "nextTurn",
            workLane: false,
        });
        await engine.preflight(def);
        await engine.preflight({ ...def, cwd: f.cwd });
        const missing = join(f.root, "missing");
        await assert.rejects(engine.preflight({ ...def, cwd: missing }), {
            message:
                `agent type "${def.agentType}" is set to run in ${missing}, which is not an ` +
                "existing directory. Ask the user to fix the subagent's directory in its settings.",
        });
        const file = join(f.root, "file");
        await writeFile(file, "not a directory");
        await assert.rejects(engine.preflight({ ...def, cwd: file }), /not an existing directory/);
        assert.equal(f.claudeOptions.length, 0);
    });

    it("rejects an inherited main-checkout cwd at preflight and start before querying", async (t) => {
        const f = await fixture(t);
        const worktree = join(f.cwd, ".taco", "worktrees", "topic");
        await mkdir(worktree, { recursive: true });
        const engine = createClaudeCodeEngine({
            ...f.claudeDeps,
            executionCwd: () => worktree,
            getAllowedCwds: () => [worktree],
        });
        await assert.rejects(engine.preflight({ ...def, cwd: f.cwd }), /associated directories/);
        const result = await engine.run(request({ claudeCodeCwd: f.cwd }));
        assert.equal(result.isError, true);
        assert.equal(result.subSessionId, childId);
        assert.match(result.resultText, /associated directories/);
        assert.equal(f.claudeOptions.length, 0);
        assert.equal(f.writes.length, 0);
        assert.equal(await readClaudeCodeState(f.session), undefined);
    });

    it("canonicalizes cwd and rechecks the current grants at start and resume", async (t) => {
        const f = await fixture(t);
        const associated = join(f.root, "associated");
        const alias = join(f.root, "alias");
        await mkdir(associated);
        await symlink(associated, alias, "dir");
        let allowed = [f.cwd, alias];
        const engine = createClaudeCodeEngine({ ...f.claudeDeps, getAllowedCwds: () => allowed });
        const args = request({ claudeCodeCwd: alias });
        await engine.preflight({ ...def, cwd: alias });
        allowed = [f.cwd];
        assert.match((await engine.run(args)).resultText, /associated directories/);
        assert.equal(f.claudeOptions.length, 0);
        allowed = [f.cwd, associated];
        assert.equal((await engine.run(args)).isError, false);
        assert.equal(f.claudeOptions[0]?.cwd, associated);
        assert.equal((await readClaudeCodeState(f.session))?.cwd, associated);
        assert.equal((await engine.run({ ...args, resume: true })).isError, false);
        allowed = [f.cwd];
        const resumed = await engine.run({ ...args, resume: true });
        assert.equal(resumed.isError, true);
        assert.match(resumed.resultText, /associated directories/);
        assert.equal(f.claudeOptions.length, 2);
    });

    it("rejects resume after its original directory grant is revoked", async (t) => {
        const f = await fixture(t);
        const associated = join(f.root, "resume-directory");
        await mkdir(associated);
        let allowed = [f.cwd, associated];
        const engine = createClaudeCodeEngine({ ...f.claudeDeps, getAllowedCwds: () => allowed });
        const args = request({ claudeCodeCwd: associated });
        assert.equal((await engine.run(args)).isError, false);
        allowed = [f.cwd];
        const result = await engine.run({ ...args, resume: true });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /associated directories/);
        assert.equal(f.claudeOptions.length, 1);
    });

    it("fails closed when the default execution directory disappears before start", async (t) => {
        const f = await fixture(t);
        const engine = createClaudeCodeEngine(f.claudeDeps);
        await engine.preflight(def);
        await rm(f.cwd, { recursive: true });
        const result = await engine.run(request());
        assert.equal(result.isError, true);
        assert.match(result.resultText, /not an existing directory/);
        assert.equal(f.claudeOptions.length, 0);
    });

    it("persists and resumes the same native session through the provided callbacks", async (t) => {
        const f = await fixture(t);
        const engine = createClaudeCodeEngine(f.claudeDeps);
        const first = request({
            permissionMode: "plan",
            rolePrompt: def.systemPrompt,
            maxTurns: 3,
        });
        assert.equal((await engine.run(first)).resultText, "Claude answer");
        assert.deepEqual(await readClaudeCodeState(f.session), {
            nativeSessionId: "claude-native-1",
            cwd: f.cwd,
            configDir: process.env.CLAUDE_CONFIG_DIR,
            tools: [],
            permissionMode: "plan",
        });
        assert.ok(f.writes.every(({ id }) => id === childId));
        assert.deepEqual(
            f.writes.flatMap(({ messages }) => messages.map((m) => m.role)),
            ["user", "assistant"],
        );
        assert.equal(f.inputs[0]?.[0], childId);
        assert.equal(f.claudeOptions[0]?.abortController, first.abortController);
        assert.equal(f.claudeOptions[0]?.maxTurns, 3);
        assert.equal(f.claudeOptions[0]?.systemPrompt.append, def.systemPrompt);
        const next = await engine.run({ ...first, resume: true, prompt: "next question" });
        assert.equal(next.isError, false);
        assert.equal(f.claudeOptions[1]?.resume, "claude-native-1");
    });

    it("rejects missing native mappings and changed cwd/tools/mode/storage without a query", async (t) => {
        const f = await fixture(t);
        const engine = createClaudeCodeEngine({
            ...f.claudeDeps,
            getAllowedCwds: () => [f.cwd, f.root],
        });
        assert.match(
            (await engine.run(request({ resume: true }))).resultText,
            /mapping was not saved/,
        );
        await engine.run(request());
        const original = await readClaudeCodeState(f.session);
        assert.ok(original);
        for (const change of [
            { claudeCodeCwd: f.root },
            { claudeCodeTools: ["Read"] },
            { permissionMode: "plan" as const },
        ]) {
            const result = await engine.run(request({ resume: true, ...change }));
            assert.equal(result.isError, true);
            assert.match(result.resultText, /profile changed/);
        }
        await writeClaudeCodeState(f.session, { ...original, configDir: "different-storage" });
        assert.match((await engine.run(request({ resume: true }))).resultText, /profile changed/);
        assert.equal(f.claudeOptions.length, 1);
    });

    it("splits communication grants from native tools and preserves permission options", async (t) => {
        const f = await fixture(t);
        await createClaudeCodeEngine(f.claudeDeps).run(
            request({
                claudeCodeTools: ["Read", "mcp__taco__listAgentSessions"],
                permissionMode: "bypassPermissions",
            }),
        );
        const options = f.claudeOptions[0];
        assert.ok(options);
        assert.deepEqual(options.tools, ["Read"]);
        assert.deepEqual(options.allowedTools, ["mcp__taco__listAgentSessions"]);
        assert.equal(options.permissionMode, "bypassPermissions");
        assert.equal(options.allowDangerouslySkipPermissions, true);
        assert.equal(options.permissionPrompts, "none");
        assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
    });

    it("consumes the supplied controller without linking the caller signal", async (t) => {
        const f = await fixture(t);
        const caller = new AbortController();
        caller.abort();
        const args = request({ signal: caller.signal });
        const result = await createClaudeCodeEngine(f.claudeDeps).run(args);
        assert.equal(result.isError, false);
        assert.equal(args.abortController.signal.aborted, false);
    });
});

describe("Codex engine adapter", () => {
    it("advertises afterRun delivery and validates cwd before constructing the SDK", async (t) => {
        const f = await fixture(t);
        const engine = createCodexEngine(f.codexDeps);
        assert.equal(engine.runtime, "codex");
        assert.deepEqual(engine.capabilities, {
            forkContext: false,
            delivery: "afterRun",
            workLane: true,
        });
        await assert.rejects(
            engine.preflight({ ...def, codex: { cwd: f.root } }),
            /workspace directory or one of its associated directories/,
        );
        await assert.rejects(
            engine.preflight({ ...def, codex: { cwd: join(f.root, "missing") } }),
            /not an existing directory/,
        );
        assert.equal(f.loadCount(), 0);
        await engine.preflight(def);
        assert.equal(f.loadCount(), 1);
        assert.equal(f.clients.length, 1);
        assert.equal(f.starts.length, 0);
    });

    it("canonicalizes symlinks and re-reads the allowed roots on each preflight", async (t) => {
        const f = await fixture(t);
        const alias = join(f.root, "alias");
        await symlink(f.cwd, alias, "dir");
        let allowed = [alias];
        const engine = createCodexEngine({ ...f.codexDeps, getAllowedCwds: () => allowed });
        await engine.preflight({ ...def, codex: { cwd: alias } });
        await engine.run(request({ codexConfig: { cwd: alias } }));
        assert.equal(f.starts[0]?.workingDirectory, f.cwd);
        allowed = [f.root];
        await assert.rejects(engine.preflight(def), /associated directories/);
    });

    it("reports both missing SDKs and platform binary construction failures during preflight", async (t) => {
        const f = await fixture(t);
        const missing = createCodexEngine({
            ...f.codexDeps,
            loadCodexSdkForRun: async () => {
                throw new Error("missing SDK");
            },
        });
        await assert.rejects(missing.preflight(def), /managed Codex runtime is not installed/);
        const missingBinary = createCodexEngine({
            ...f.codexDeps,
            loadCodexSdkForRun: async () =>
                f.loaded({
                    Codex: class {
                        constructor() {
                            throw new Error("Missing optional dependency for CLI binaries");
                        }
                        startThread(): never {
                            throw new Error("unreachable");
                        }
                        resumeThread(): never {
                            throw new Error("unreachable");
                        }
                    },
                }),
        });
        await assert.rejects(
            missingBinary.preflight(def),
            /platform-specific CLI binary is missing/,
        );
    });

    it("persists defaults, appends under the child ID and resumes the exact native thread", async (t) => {
        const f = await fixture(t);
        const engine = createCodexEngine(f.codexDeps);
        const args = request({ codexConfig: { model: "   " }, executionId: "execution-1" });
        assert.equal((await engine.run(args)).isError, false);
        const state = await readCodexState(f.session);
        assert.ok(state);
        assert.equal(state.nativeThreadId, "codex-native-1");
        assert.equal(state.cwd, f.cwd);
        assert.equal(state.sdkVersion, CODEX_SDK_VERSION);
        assert.deepEqual(state.threadOptions, {
            sandbox: "read-only",
            approvalPolicy: "never",
            skipGitRepoCheck: true,
        });
        assert.equal(f.starts[0]?.model, undefined);
        assert.equal(f.starts[0]?.sandboxMode, "read-only");
        assert.equal(f.starts[0]?.approvalPolicy, "never");
        assert.equal(f.signals[0], args.abortController.signal);
        assert.deepEqual(f.running, [{ id: childId, runId: "execution-1" }]);
        assert.ok(f.writes.every(({ id }) => id === childId));
        assert.deepEqual(
            f.writes.flatMap(({ messages }) => messages.map((m) => m.role)),
            ["user", "assistant"],
        );
        await engine.run({ ...args, resume: true, prompt: "next question" });
        assert.equal(f.starts.length, 1);
        assert.equal(f.resumes[0]?.id, "codex-native-1");
        assert.deepEqual(await readCodexState(f.session), state);
    });

    it("detects Git worktrees through ancestor .git files and normalizes model overrides", async (t) => {
        const f = await fixture(t);
        await writeFile(join(f.root, ".git"), "gitdir: elsewhere");
        await createCodexEngine(f.codexDeps).run(request({ codexConfig: { model: " gpt-test " } }));
        assert.equal(f.starts[0]?.skipGitRepoCheck, undefined);
        assert.equal(f.starts[0]?.model, "gpt-test");
        assert.equal((await readCodexState(f.session))?.threadOptions.skipGitRepoCheck, false);
    });

    it("rejects missing mappings and profile/SDK/worktree changes before starting a thread", async (t) => {
        const f = await fixture(t);
        const engine = createCodexEngine(f.codexDeps);
        assert.match(
            (await engine.run(request({ resume: true }))).resultText,
            /mapping was not saved/,
        );
        await engine.run(request());
        const state = await readCodexState(f.session);
        assert.ok(state);
        for (const change of [
            { codexConfig: { model: "different" } },
            { codexTools: ["chatToAgent"] },
            { rolePrompt: "changed role" },
        ]) {
            assert.match(
                (await engine.run(request({ resume: true, ...change }))).resultText,
                /profile changed/,
            );
        }
        await writeCodexState(f.session, { ...state, sdkVersion: "old-sdk" });
        assert.match((await engine.run(request({ resume: true }))).resultText, /profile changed/);
        await writeCodexState(f.session, state);
        await mkdir(join(f.cwd, ".git"));
        assert.match((await engine.run(request({ resume: true }))).resultText, /profile changed/);
        assert.equal(f.starts.length, 1);
        assert.equal(f.resumes.length, 0);
    });

    it("keeps the original cwd failure result shape if the directory disappears before run", async (t) => {
        const f = await fixture(t);
        const engine = createCodexEngine(f.codexDeps);
        await engine.preflight(def);
        await rm(f.cwd, { recursive: true });
        const result = await engine.run(request());
        assert.equal(result.isError, true);
        assert.equal(result.subSessionId, childId);
        assert.match(result.resultText, /not an existing directory/);
    });

    it("leaves SDK availability to the required preflight boundary", async (t) => {
        const f = await fixture(t);
        await createCodexEngine(f.codexDeps).run(request());
        let loads = 0;
        const engine = createCodexEngine({
            ...f.codexDeps,
            loadCodexSdkForRun: async () => {
                loads++;
                throw new Error("SDK removed");
            },
        });
        await assert.rejects(engine.preflight(def), /managed Codex runtime/);
        assert.equal(loads, 1);
    });

    for (const fail of [false, true]) {
        it(`closes the communication bridge after a ${fail ? "failed" : "successful"} run`, async (t) => {
            const f = await fixture(t);
            if (fail) f.failStream();
            const result = await createCodexEngine(f.codexDeps).run(
                request({ codexTools: ["mcp__taco__listAgentSessions"] }),
            );
            assert.equal(result.isError, fail);
            const servers = f.clients.at(-1)?.config?.mcp_servers as {
                taco?: { env: Record<string, string> };
            };
            const socket = servers.taco?.env.TACO_CODEX_BRIDGE_SOCKET;
            assert.ok(socket);
            if (process.platform !== "win32") assert.equal(existsSync(socket), false);
            assert.deepEqual(
                (await readCodexState(f.session))?.threadOptions.communicationTools,
                fail ? undefined : ["listAgentSessions"],
            );
        });
    }
});

it("scrubs injected provider keys from both native SDKs and Codex preflight", async (t) => {
    const f = await fixture(t);
    const previous = process.env.OPENAI_API_KEY;
    const store = new ProviderKeyStore({ openai: "sidecar-injected-test-key" });
    t.after(() => {
        store.update({ openai: "" });
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
    });
    await createClaudeCodeEngine(f.claudeDeps).run(request());
    const codex = createCodexEngine(f.codexDeps);
    await codex.preflight(def);
    await codex.run(request({ codexTools: ["listAgentSessions"] }));
    assert.equal(f.claudeOptions[0]?.env.OPENAI_API_KEY, undefined);
    assert.equal(f.clients[0]?.env?.OPENAI_API_KEY, undefined);
    assert.equal(f.clients[1]?.env?.OPENAI_API_KEY, undefined);
    const servers = f.clients[1]?.config?.mcp_servers as { taco: { env: Record<string, string> } };
    assert.equal(servers.taco.env.OPENAI_API_KEY, undefined);
});
