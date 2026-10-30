/**
 * AttachedSession — real-harness turn behaviour (streaming, failure paths,
 * terminate-only turns) and the deferred-tool controller.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import {
    AttachedSession,
    type AttachedSessionOptions,
} from "../../src/runtime/harness/attachedSession.ts";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/harness/deferredToolRegistry.ts";
import { resolvePromptReply } from "../../src/runtime/harness/promptReply.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { AgentMessage, Api, Entry, Model } from "../../src/runtime/pi/types.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import { normalizeMessageUpdate } from "../../src/server/push.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";
import type { TacoToolContextBase } from "../../src/tools/context.ts";
import type { TacoTool } from "../../src/tools/index.ts";

describe("attachedSession.streaming", () => {
    /** Sub-event shape the desktop renderer reads off a normalized frame. */
    interface SubEvent {
        type?: string;
        delta?: string;
    }

    let tmp: string;

    before(() => {
        tmp = mkdtempSync(join(tmpdir(), "taco-streaming-"));
    });

    after(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    /** Build an AttachedSession over a faux provider. `register: false` leaves the
     *  provider out of the model registry, which makes the run fail with
     *  `model_unavailable` — the cheapest way to reach a terminal non-success run.
     *  `responses` overrides the default single-message response, and `tools` wires
     *  a tool surface into the harness so a single-turn run can close on a tool
     *  result rather than an assistant reply. */
    async function makeAttached(
        reply: string,
        register = true,
        options: {
            responses?: unknown[];
            tools?: unknown[];
        } = {},
    ) {
        const env = new NodeExecutionEnv({ cwd: tmp });
        const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(tmp, "sessions") });
        // tokensPerSecond: 0 removes the pacing delay — the deltas still arrive as
        // separate events, the test just does not wait out a simulated token rate.
        const faux = fauxProvider({ provider: "faux", tokensPerSecond: 0 } as never);
        faux.setResponses(
            (options.responses ?? [fauxAssistantMessage([fauxText(reply)])]) as never,
        );
        const models = createModels();
        if (register) models.setProvider(faux.provider);

        const session = await repo.create({ cwd: tmp }, harnessContext);
        const attached = await AttachedSession.create({
            session,
            models,
            model: faux.getModel(),
            env,
            systemPrompt: "test",
            tools: (options.tools ?? []) as never,
            resources: {},
            streamOptions: {},
            taskStore: {
                lists: new Map(),
                getTaskState: () => ({ planMode: false, currentTask: undefined }),
                setTaskState: () => {},
            } as unknown as TaskStore,
            planState: createPlanModeState(),
            tasksDir: tmp,
            attachmentsDir: tmp,
            sessionCwd: tmp as never,
            getToolContext: () => ({ env, workspace: tmp as never }) as never,
        } as never);

        return attached;
    }

    /** Stream `reply` through a real harness; return every republished event. */
    async function runStreamingTurn(reply: string): Promise<Array<Record<string, unknown>>> {
        const attached = await makeAttached(reply);
        const events: Array<Record<string, unknown>> = [];
        attached.on("event", (ev: Record<string, unknown>) => events.push(ev));
        try {
            await attached.prompt("hi", undefined, undefined);
            return events;
        } finally {
            await attached.dispose();
        }
    }

    describe("AttachedSession — streaming a turn", () => {
        it("republishes incremental message_update events, not just the final message", async () => {
            const events = await runStreamingTurn("hello streaming world");
            const updates = events.filter((e) => e.type === "message_update");
            assert.ok(
                updates.length > 0,
                `expected incremental updates, got only: ${events.map((e) => e.type).join(", ")}`,
            );
        });

        /**
         * The case D1 exists for. A run interrupted by a killed process stays in
         * the lane's `state.operation`, which is the same slot `lane.prompt()`
         * rejects on — so without resume the session is permanently unusable, and
         * a restart does not help because the operation is durable.
         *
         * Proven directly here rather than asserted on a stub: the first attach is
         * abandoned mid-prompt (session closed under the running turn), then a
         * second `AttachedSession.create` over the same session must recover on its
         * own and accept a fresh prompt.
         */
        it("resumes an operation interrupted by a killed process, so the lane accepts prompts again", async () => {
            const env = new NodeExecutionEnv({ cwd: tmp });
            const repo = new JsonlSessionRepo({
                fileSystem: env,
                sessionsRoot: join(tmp, "sessions"),
            });
            // A *paced* provider is what makes this deterministic. With
            // `tokensPerSecond: 0` the reply lands in one tick and the run settles
            // before the close, leaving nothing open (measured: only a 1-3ms window
            // produced an open operation, i.e. a flaky test). The stream is paced
            // just enough that the close below lands while a chunk is still
            // scheduled; the test waits for the first delta instead of sleeping.
            const faux = fauxProvider({ provider: "faux", tokensPerSecond: 50 } as never);
            const models = createModels();
            models.setProvider(faux.provider);
            const id = uuidv7();
            const longReply = "a fairly long reply with many tokens to pace out";

            const build = async (session: unknown) =>
                await AttachedSession.create({
                    session,
                    models,
                    model: faux.getModel(),
                    env,
                    systemPrompt: "test",
                    tools: [],
                    resources: {},
                    streamOptions: {},
                    taskStore: {
                        lists: new Map(),
                        getTaskState: () => ({ planMode: false, currentTask: undefined }),
                        setTaskState: () => {},
                    } as unknown as TaskStore,
                    planState: createPlanModeState(),
                    tasksDir: tmp,
                    attachmentsDir: tmp,
                    sessionCwd: tmp as never,
                    getToolContext: () => ({ env, workspace: tmp as never }) as never,
                } as never);

            // First attach: start a turn and close the session on the first streamed
            // delta — the run is mid-flight by construction, which is what a killed
            // process looks like. Awaiting the prompt is pointless: it never
            // completes normally.
            faux.setResponses([fauxAssistantMessage([fauxText(longReply)])] as never);
            const first = await repo.create({ id, cwd: tmp }, harnessContext);
            const attached1 = await build(first);
            const firstDelta = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("no message_update arrived before the close")),
                    10_000,
                );
                attached1.on("event", (ev: Record<string, unknown>) => {
                    if (ev.type !== "message_update") return;
                    clearTimeout(timer);
                    resolve();
                });
            });
            const abandoned = attached1.prompt("go", undefined, undefined).catch(() => undefined);
            await firstDelta;
            await first.close(harnessContext).catch(() => undefined);
            await abandoned;

            // Second attach over the same session: create() reports the open
            // operation and AttachedSession resumes it in the background.
            const list = await repo.list(undefined, harnessContext);
            const meta = list.find((m) => m.id === id);
            assert.ok(meta, "the interrupted session should still be listed");
            // Queue both replies up front: one for the resumed run, one for the
            // prompt below. Setting them one at a time races the resume, which
            // starts as soon as `create()` returns and consumes the head of the
            // queue.
            faux.setResponses([
                fauxAssistantMessage([fauxText("recovered")]),
                fauxAssistantMessage([fauxText("second")]),
            ] as never);
            const attached2 = await build(await repo.open(meta, harnessContext));
            try {
                assert.equal(
                    attached2.resumableOperations.length,
                    1,
                    "the interrupted run should be reported as open",
                );

                // The assertion that matters: this same call fails with LaneBusy
                // while the recovered operation still occupies the lane, so it only
                // succeeds because `prompt` waits for recovery to settle first.
                const reply = await attached2.prompt("again", undefined, undefined);
                assert.equal(reply.role, "assistant");

                // Recovery is reported as having actually recovered, not merely
                // attempted — `failed` here would mean the prompt above only worked
                // by luck.
                assert.equal(attached2.recoveryOutcomes.length, 1);
                assert.equal(attached2.recoveryOutcomes[0]?.status, "recovered");
            } finally {
                await attached2.dispose();
            }
        });

        it("starts with an empty resumableOperations array on a fresh session", async () => {
            // pi's `AgentHarness.create()` returns the open[] array — durable
            // operations left in flight by a previous process. A fresh session over
            // a faux provider consumes its only response and settles, so the
            // array must be empty. The field is kept internal for structured
            // logging; a non-empty default would mean every attach logs a spurious
            // "interrupted operations" warning.
            const attached = await makeAttached("once");
            try {
                assert.deepEqual(attached.resumableOperations, []);
                // Nothing to recover means recovery never ran, so no outcomes.
                assert.deepEqual(attached.recoveryOutcomes, []);
            } finally {
                await attached.dispose();
            }
        });

        it("carries the streamed deltas under the field clients read", async () => {
            const events = await runStreamingTurn("hello streaming world");
            const subs = events
                .filter((e) => e.type === "message_update")
                .map(
                    (e) =>
                        (normalizeMessageUpdate(e) as { assistantMessageEvent?: SubEvent })
                            .assistantMessageEvent,
                );

            assert.ok(
                subs.every((s) => s !== undefined),
                "a missing sub-event makes the renderer drop the delta and show the reply all at once",
            );
            // The concatenated deltas must reconstruct the reply — proof the UI can
            // build the text incrementally rather than waiting for message_end.
            const streamed = subs
                .filter((s) => s?.type === "text_delta")
                .map((s) => s?.delta ?? "")
                .join("");
            assert.equal(streamed, "hello streaming world");
        });
    });

    describe("AttachedSession.prompt — a run that fails without a reply", () => {
        it("reports the operation's own error, not the missing-reply symptom", async () => {
            // The run resolves ok:true (reaching a terminal state is not a call
            // failure) with status "failed" and the reason in record.error. Reading
            // the branch tip first finds the user message still there and reports
            // "expected an assistant reply, got role=user" — the symptom, with the
            // actual cause discarded.
            const attached = await makeAttached("unused", false);
            try {
                await assert.rejects(
                    () => attached.prompt("hi", undefined, undefined),
                    (error: Error & { code?: string }) => {
                        assert.match(error.message, /model_unavailable/);
                        assert.equal(
                            error.code,
                            "model_unavailable",
                            "code is carried for RPC mapping",
                        );
                        assert.doesNotMatch(
                            error.message,
                            /expected an assistant reply/,
                            "the symptom must not mask the cause",
                        );
                        return true;
                    },
                );
            } finally {
                await attached.dispose();
            }
        });
    });

    /**
     * The end-to-end proof that a turn closing on a terminating tool call is a
     * normal outcome. This has to run against a real harness: the claim under test
     * is about pi's own behaviour (`allTerminate` flips the checkpoint continuation
     * to `may_finish` with `includeFinalAssistant: false`, so the run completes
     * with the toolResult as the branch tip), and a hand-written fixture would
     * assert what we *believe* pi produces rather than what it does.
     */
    describe("AttachedSession.prompt — a turn that closes on a terminating tool call", () => {
        it("returns the toolResult as the reply instead of throwing", async () => {
            const terminatingTool = {
                name: "askUser",
                label: "askUser",
                description: "test stub",
                parameters: { type: "object", properties: {} },
                executionMode: "sequential",
                async execute() {
                    return {
                        content: [{ type: "text", text: "ask first" }],
                        details: { questions: [], waiting: true },
                        terminate: true,
                    };
                },
            };
            const attached = await makeAttached("unused", true, {
                responses: [
                    fauxAssistantMessage([
                        fauxText("need to ask"),
                        { type: "toolCall", id: "tc-1", name: "askUser", arguments: {} },
                    ]),
                ],
                tools: [terminatingTool],
            });
            try {
                const reply = await attached.prompt("hi", undefined, undefined);
                assert.equal(
                    reply.role,
                    "toolResult",
                    "a terminate-only turn must surface the toolResult entry as the reply",
                );
                // toolCallId / toolName must round-trip from the tool call into the
                // returned message — that is what resolveAskUserQuestions matches on
                // when the desktop later submits the user's answers.
                const tr = reply as { toolCallId?: string; toolName?: string };
                assert.equal(tr.toolName, "askUser");
                assert.equal(tr.toolCallId, "tc-1");
            } finally {
                await attached.dispose();
            }
        });
    });

    describe("resolvePromptReply — accepts a terminating toolResult, rejects every other non-assistant tip", () => {
        // Unit coverage for the branches a harness run cannot reach: the faux
        // provider throws `assistant_error` rather than producing a
        // non-terminating toolResult tip, so the anomaly guard would otherwise go
        // unverified. The accept-path is covered end-to-end by the suite above.
        //
        // Fixtures are full `Entry` values (not partials) because `resolvePromptReply`
        // takes pi's real `Entry` union — a partial would not typecheck, which is
        // the point: the compiler keeps these in step with upstream.
        const entryBase = { id: "e-1", parentId: null, seq: 1, timestamp: 0 } as const;
        const messageEntry = (message: AgentMessage, terminate?: true): Entry => ({
            ...entryBase,
            type: "message",
            message,
            ...(terminate ? { terminate } : {}),
        });

        const assistantReply: AgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            api: "faux",
            provider: "faux",
            model: "faux-1",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
        };
        const toolResultReply: AgentMessage = {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "askUser",
            content: [{ type: "text", text: "ask" }],
            isError: false,
            timestamp: 0,
        };
        const userReply: AgentMessage = {
            role: "user",
            content: [{ type: "text", text: "oops" }],
            timestamp: 0,
        };

        it("accepts an assistant message", () => {
            assert.equal(
                resolvePromptReply(assistantReply, messageEntry(assistantReply)),
                "accept",
            );
        });

        it("accepts a toolResult whose entry carries terminate:true", () => {
            assert.equal(
                resolvePromptReply(toolResultReply, messageEntry(toolResultReply, true)),
                "accept",
                "askUser / planExit-style close must surface the toolResult as a normal reply",
            );
        });

        it("rejects a toolResult whose entry has no terminate flag (real anomaly)", () => {
            assert.equal(
                resolvePromptReply(toolResultReply, messageEntry(toolResultReply)),
                "reject",
                "accepting this would mask an upstream shape change",
            );
        });

        it("rejects a toolResult reply carried by a non-message entry (e.g. compaction)", () => {
            const compactionEntry: Entry = {
                ...entryBase,
                type: "compaction",
                summary: "s",
                retainedTail: [],
                tokensBefore: 0,
                fromHook: false,
            };
            assert.equal(resolvePromptReply(toolResultReply, compactionEntry), "reject");
        });

        it("rejects a user-role reply (aborted / early-error path)", () => {
            assert.equal(resolvePromptReply(userReply, messageEntry(userReply)), "reject");
        });

        it("rejects when there is no reply at all", () => {
            assert.equal(resolvePromptReply(undefined, undefined), "reject");
        });
    });
});

describe("attachedSession.deferredTools", () => {
    const fakeTool = (name: string): TacoTool =>
        ({
            name,
            label: name,
            description: `summary:${name}`,
            parameters: {},
            async execute() {
                return { content: [{ type: "text", text: "ok" }], details: {} };
            },
        }) as unknown as TacoTool;

    const stubModel: Model<Api> = {
        id: "test/claude-test",
        provider: "anthropic",
        contextWindow: 200_000,
    } as unknown as Model<Api>;

    const stubTools: TacoTool[] = [fakeTool("builtin-tool")];

    function makeToolCandidate(name: string, loading: "deferred" | "always"): ToolCandidate {
        return {
            name,
            summary: `summary:${name}`,
            loading,
            source: "builtin",
            load: async () => fakeTool(name),
        };
    }

    let tmpDir: string;
    let sessionsRoot: string;
    let repo: JsonlSessionRepo;
    let env: NodeExecutionEnv;
    let models: ReturnType<typeof createModels>;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "taco-dt-int-"));
        sessionsRoot = join(tmpDir, "sessions");
        env = new NodeExecutionEnv({ cwd: tmpDir });
        repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
        models = createModels();
    });

    after(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    async function makeAttachedSession(
        toolRegistry: DefaultDeferredToolRegistry,
    ): Promise<AttachedSession> {
        const session = await repo.create({ cwd: tmpDir }, harnessContext);
        const opts: AttachedSessionOptions = {
            session,
            models,
            model: stubModel,
            env,
            systemPrompt: "test prompt",
            tools: [...stubTools],
            resources: {},
            streamOptions: {},
            taskStore: {
                getTaskState: () => ({ planMode: false, currentTask: undefined }),
                setTaskState: () => {},
            } as unknown as TaskStore,
            planState: createPlanModeState(),
            tasksDir: tmpDir,
            attachmentsDir: tmpDir,
            toolRegistry,
            sessionCwd: tmpDir as never,
            // Dynamic-tool tests don't exercise the tool context path; tools that
            // need `call`/`actor` are tested in their own files.
            getToolContext: () => ({ env, workspace: tmpDir as never }) as TacoToolContextBase,
            sessionKind: "main",
        };
        return AttachedSession.create(opts);
    }

    describe("AttachedSession — dynamic tools", () => {
        it("always candidates are present in the initial active tool set", async () => {
            const registry = new DefaultDeferredToolRegistry({
                candidates: [
                    makeToolCandidate("always-tool", "always"),
                    makeToolCandidate("deferred-tool", "deferred"),
                ],
            });
            const attached = await makeAttachedSession(registry);
            assert.ok(
                attached.toolController != null,
                "toolController must be set when registry is provided",
            );

            const activeNames = await attached.toolController.activeToolNames();
            assert.ok(
                activeNames.includes("always-tool"),
                `always-tool must be in initial active set, got: ${activeNames.join(", ")}`,
            );
            assert.ok(
                !activeNames.includes("deferred-tool"),
                `deferred-tool must not be pre-loaded, got: ${activeNames.join(", ")}`,
            );
            await attached.abort();
        });

        it("addTools adds the tool to the harness active set", async () => {
            const registry = new DefaultDeferredToolRegistry({
                candidates: [makeToolCandidate("git-status", "deferred")],
            });
            const attached = await makeAttachedSession(registry);
            assert.ok(attached.toolController != null, "toolController must be set");
            assert.ok(
                (await attached.toolController.activeToolNames()).includes("addTools"),
                "addTools must be resident",
            );

            const result = await attached.toolController.addTools(["git-status"]);
            assert.deepEqual(result.added, ["git-status"]);

            assert.ok(
                (await attached.toolController.activeToolNames()).includes("git-status"),
                "git-status must be active after addTools",
            );
            await attached.abort();
        });

        it("duplicate names in a single addTools request are idempotent", async () => {
            const registry = new DefaultDeferredToolRegistry({
                candidates: [makeToolCandidate("git-status", "deferred")],
            });
            const attached = await makeAttachedSession(registry);
            assert.ok(attached.toolController != null, "toolController must be set");

            const result = await attached.toolController.addTools(["git-status", "git-status"]);
            assert.deepEqual(result.added, ["git-status"]);
            assert.ok(result.skipped.includes("git-status"), "second occurrence must be skipped");

            const activeNames = await attached.toolController.activeToolNames();
            assert.equal(
                activeNames.filter((n) => n === "git-status").length,
                1,
                "git-status must appear exactly once in active set",
            );
            await attached.abort();
        });

        it("an always candidate factory failure causes attach to fail", async () => {
            const badCandidate: ToolCandidate = {
                name: "always-fail",
                summary: "always-fail",
                loading: "always",
                source: "builtin",
                load: async () => {
                    throw new Error("factory-error");
                },
            };
            const registry = new DefaultDeferredToolRegistry({
                candidates: [badCandidate],
            });
            await assert.rejects(makeAttachedSession(registry), /factory-error/);
        });

        it("re-attaching a session that persisted an always tool does not re-invoke its factory", async () => {
            // On the previous attach, addTools()/setTools() persists the full active
            // set (including the always tool) into the session branch as an
            // active_tools_change entry. A subsequent re-attach must not call the
            // always tool's factory a second time: for MCP-backed candidates this
            // would re-open the child process, and for any candidate whose load()
            // has side effects (connections, allocations, locks) it doubles the
            // cost of every restart.
            let loadCount = 0;
            const always: ToolCandidate = {
                name: "always-tool",
                summary: "always-tool",
                loading: "always",
                source: "builtin",
                load: async () => {
                    loadCount += 1;
                    return fakeTool("always-tool");
                },
            };
            const deferred: ToolCandidate = {
                name: "lazy-tool",
                summary: "lazy-tool",
                loading: "deferred",
                source: "builtin",
                load: async () => fakeTool("lazy-tool"),
            };
            const registry = new DefaultDeferredToolRegistry({ candidates: [always, deferred] });

            const session = await repo.create({ cwd: tmpDir }, harnessContext);
            const attachedOpts: AttachedSessionOptions = {
                session,
                models,
                model: stubModel,
                env,
                systemPrompt: "test prompt",
                tools: [...stubTools],
                resources: {},
                streamOptions: {},
                taskStore: {
                    getTaskState: () => ({ planMode: false, currentTask: undefined }),
                    setTaskState: () => {},
                } as unknown as TaskStore,
                planState: createPlanModeState(),
                tasksDir: tmpDir,
                attachmentsDir: tmpDir,
                toolRegistry: registry,
                sessionCwd: tmpDir as never,
                getToolContext: (): TacoToolContextBase => ({
                    env,
                    workspace: tmpDir as never,
                }),
                sessionKind: "main",
            };

            // First attach: load runs once for the always candidate. Then trigger
            // setTools via addTools so the session branch records an
            // active_tools_change entry containing "always-tool".
            const first = await AttachedSession.create(attachedOpts);
            await first.toolController?.addTools(["lazy-tool"]);
            await first.abort();
            assert.equal(loadCount, 1, "first attach must load the always candidate once");

            // Second attach against the same session branch. restoreTools reads
            // activeToolNames = [...,"always-tool",...]; without the fix, the
            // always block in attachedSession.ts would re-load it as well.
            const reloaded = await AttachedSession.create(attachedOpts);
            const activeNames = (await reloaded.toolController?.activeToolNames()) ?? [];
            assert.ok(
                activeNames.includes("always-tool"),
                `always-tool must remain active after re-attach, got: ${activeNames.join(", ")}`,
            );
            assert.equal(
                loadCount,
                2,
                "re-attach must load the always candidate exactly once more (not twice)",
            );
            await reloaded.abort();
        });

        it("re-alignment preserves a persisted name whose candidate failed to load", async () => {
            // restoreTools deliberately swallows a failing load and leaves the name
            // on the persisted allowlist so the next attach retries it (an MCP
            // server that is merely down must not cost the user their tool). The
            // allowlist re-alignment intersects against the assembled toolset,
            // which excludes tools that failed to load — so it must not treat
            // "failed to load this time" as "revoked by policy", or a transient MCP
            // outage would silently drop the tool forever.
            let failLoad = true;
            const flaky: ToolCandidate = {
                name: "flaky-mcp-tool",
                summary: "flaky-mcp-tool",
                loading: "deferred",
                source: "mcp",
                load: async () => {
                    if (failLoad) throw new Error("mcp server down");
                    return fakeTool("flaky-mcp-tool");
                },
            };
            const registry = new DefaultDeferredToolRegistry({ candidates: [flaky] });
            const session = await repo.create({ cwd: tmpDir }, harnessContext);
            const opts = {
                session,
                models,
                model: stubModel,
                env,
                systemPrompt: "test prompt",
                tools: [fakeTool("builtin-tool")],
                resources: {},
                streamOptions: {},
                taskStore: {
                    getTaskState: () => ({ planMode: false, currentTask: undefined }),
                    setTaskState: () => {},
                } as unknown as TaskStore,
                planState: createPlanModeState(),
                tasksDir: tmpDir,
                attachmentsDir: tmpDir,
                toolRegistry: registry,
                sessionCwd: tmpDir as never,
                getToolContext: (): TacoToolContextBase => ({ env, workspace: tmpDir as never }),
                sessionKind: "main" as const,
            } as AttachedSessionOptions;

            // Load it successfully once so the name lands on the allowlist.
            failLoad = false;
            const first = await AttachedSession.create(opts);
            await first.toolController?.addTools(["flaky-mcp-tool"]);
            assert.ok(
                ((await first.toolController?.activeToolNames()) ?? []).includes("flaky-mcp-tool"),
                "precondition: the tool is on the persisted allowlist",
            );
            await first.abort();

            // Re-attach while the MCP server is down: the load throws, so the tool
            // is absent from the assembled set.
            failLoad = true;
            const reloaded = await AttachedSession.create(opts);
            assert.ok(
                ((await reloaded.toolController?.activeToolNames()) ?? []).includes(
                    "flaky-mcp-tool",
                ),
                "a name kept for retry must survive re-alignment, not be dropped as revoked",
            );
            await reloaded.abort();
        });

        it("re-attach activates a workspace tool the persisted allowlist predates", async () => {
            // An IM policy flipped from deny to allow between two daemon runs: the
            // lane's allowlist was written under the old policy and survives the
            // restart, while the workspace now defines `read`. The per-turn
            // refresher sees no change inside the new process, so only the
            // attach-time alignment can make the tool callable — otherwise the
            // prompt offers it and pi answers `Tool "read" is unavailable`.
            const registry = new DefaultDeferredToolRegistry({ candidates: [] });
            const session = await repo.create({ cwd: tmpDir }, harnessContext);
            const build = (tools: TacoTool[]) =>
                AttachedSession.create({
                    session,
                    models,
                    model: stubModel,
                    env,
                    systemPrompt: "test prompt",
                    tools,
                    resources: {},
                    streamOptions: {},
                    taskStore: {
                        getTaskState: () => ({ planMode: false, currentTask: undefined }),
                        setTaskState: () => {},
                    } as unknown as TaskStore,
                    planState: createPlanModeState(),
                    tasksDir: tmpDir,
                    attachmentsDir: tmpDir,
                    toolRegistry: registry,
                    sessionCwd: tmpDir as never,
                    getToolContext: (): TacoToolContextBase => ({
                        env,
                        workspace: tmpDir as never,
                    }),
                    sessionKind: "main",
                } as AttachedSessionOptions);

            const first = await build([fakeTool("builtin-tool")]);
            assert.ok(
                !((await first.toolController?.activeToolNames()) ?? []).includes("read"),
                "precondition: the persisted allowlist lacks read",
            );
            await first.abort();

            const reloaded = await build([fakeTool("builtin-tool"), fakeTool("read")]);
            const active = (await reloaded.toolController?.activeToolNames()) ?? [];
            assert.ok(active.includes("read"), `read must be active, got: ${active.join(", ")}`);
            assert.ok(active.includes("builtin-tool"), "existing names must be kept");
            await reloaded.abort();
        });

        it("a turn converges the toolset and the system prompt together", async () => {
            // Convergence happens per turn rather than only at attach, so a policy
            // edited mid-conversation reaches the very next message.
            const registry = new DefaultDeferredToolRegistry({ candidates: [] });
            const session = await repo.create({ cwd: tmpDir }, harnessContext);

            let granted = false;
            let refreshCalls = 0;
            const baseTools = [fakeTool("builtin-tool")];
            const refreshToolset = () => {
                refreshCalls += 1;
                return granted
                    ? { tools: [...baseTools, fakeTool("shell")], systemPrompt: "with shell" }
                    : { tools: baseTools, systemPrompt: "test prompt" };
            };

            const attached = await AttachedSession.create({
                session,
                models,
                model: stubModel,
                env,
                systemPrompt: "test prompt",
                tools: baseTools,
                resources: {},
                streamOptions: {},
                taskStore: {
                    getTaskState: () => ({ planMode: false, currentTask: undefined }),
                    setTaskState: () => {},
                } as unknown as TaskStore,
                planState: createPlanModeState(),
                tasksDir: tmpDir,
                attachmentsDir: tmpDir,
                toolRegistry: registry,
                sessionCwd: tmpDir as never,
                getToolContext: (): TacoToolContextBase => ({ env, workspace: tmpDir as never }),
                sessionKind: "main",
                refreshToolset,
            } as AttachedSessionOptions);

            const before = await attached.toolController?.activeToolNames();
            assert.ok(!(before ?? []).includes("shell"), "precondition: shell not yet granted");

            // Grant the tool, then drive a turn. The stub model rejects, which is
            // fine: the refresh runs before the lane is prompted, so the tool state
            // is already installed by the time the run fails.
            granted = true;
            await attached.prompt("hello").catch(() => undefined);

            assert.ok(refreshCalls > 0, "a turn must consult the refresher");
            const after = await attached.toolController?.activeToolNames();
            assert.ok(
                (after ?? []).includes("shell"),
                `a tool granted between turns must become active, got: ${(after ?? []).join(", ")}`,
            );
            await attached.abort();
        });

        it("a refresh swaps the workspace subset without dropping the session's own tools", async () => {
            // The refresher returns only the workspace-level set, while the session
            // also holds tools this layer installed (addTools, always candidates).
            // Installing the refresher's set verbatim would strip them — so a policy
            // edit mid-conversation would cost the session its agent/skill/addTools
            // tools along with the permission it meant to change.
            const registry = new DefaultDeferredToolRegistry({
                candidates: [makeToolCandidate("always-tool", "always")],
            });
            const session = await repo.create({ cwd: tmpDir }, harnessContext);

            let granted = false;
            const baseTools = [fakeTool("builtin-tool")];
            const attached = await AttachedSession.create({
                session,
                models,
                model: stubModel,
                env,
                systemPrompt: "test prompt",
                tools: baseTools,
                resources: {},
                streamOptions: {},
                taskStore: {
                    getTaskState: () => ({ planMode: false, currentTask: undefined }),
                    setTaskState: () => {},
                } as unknown as TaskStore,
                planState: createPlanModeState(),
                tasksDir: tmpDir,
                attachmentsDir: tmpDir,
                toolRegistry: registry,
                sessionCwd: tmpDir as never,
                getToolContext: (): TacoToolContextBase => ({ env, workspace: tmpDir as never }),
                sessionKind: "main",
                refreshToolset: () =>
                    granted
                        ? { tools: [...baseTools, fakeTool("shell")], systemPrompt: "with shell" }
                        : { tools: baseTools, systemPrompt: "test prompt" },
            } as AttachedSessionOptions);

            const before = (await attached.toolController?.activeToolNames()) ?? [];
            assert.ok(before.includes("addTools"), "precondition: addTools is resident");
            assert.ok(before.includes("always-tool"), "precondition: always candidate is resident");

            granted = true;
            await attached.prompt("hello").catch(() => undefined);

            const after = (await attached.toolController?.activeToolNames()) ?? [];
            const installed = (await attached.toolController?.installedToolNames()) ?? [];
            assert.ok(
                after.includes("shell"),
                `granted tool must activate, got: ${after.join(", ")}`,
            );
            assert.ok(
                installed.includes("shell"),
                `granted tool must be defined, got: ${installed.join(", ")}`,
            );
            for (const name of ["addTools", "always-tool"]) {
                assert.ok(
                    installed.includes(name),
                    `${name} must survive the refresh, got: ${installed.join(", ")}`,
                );
                assert.ok(
                    after.includes(name),
                    `${name} must stay active, got: ${after.join(", ")}`,
                );
            }
            await attached.abort();
        });
    });
});
