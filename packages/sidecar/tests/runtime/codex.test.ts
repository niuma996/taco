import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { SubagentProgressSink } from "../../src/agents/types.ts";
import type { AgentMessage, Session } from "../../src/runtime/pi/types.ts";
import { runCodexSubagent } from "../../src/runtime/subagent/codex/codexRunner.ts";
import {
    assertCodexSdkVersion,
    type CodexSdkModule,
    CodexSdkVersionMismatchError,
    type CodexThread,
    type CodexThreadEvent,
    type CodexThreadOptions,
    loadCodexSdkEntry,
} from "../../src/runtime/subagent/codex/codexSdk.ts";
import {
    type CodexState,
    readCodexState,
    writeCodexState,
} from "../../src/runtime/subagent/codex/codexState.ts";

const subSessionId = asSessionId("codex-child");

function events(...frames: CodexThreadEvent[]): AsyncGenerator<CodexThreadEvent> {
    return (async function* () {
        yield* frames;
    })();
}

const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
};

function answer(text: string, threadId = "thread-1"): CodexThreadEvent[] {
    return [
        { type: "thread.started", thread_id: threadId },
        {
            type: "item.completed",
            item: { id: "answer-1", type: "agent_message", text },
        },
        { type: "turn.completed", usage },
    ];
}

function fakeSdk(
    replies: CodexThreadEvent[][],
    seen: {
        options?: Record<string, unknown>;
        start?: CodexThreadOptions;
        resume?: { id: string; options?: CodexThreadOptions };
        streamOptions?: { signal?: AbortSignal };
        onEvent?: (event: CodexThreadEvent) => void;
        onClose?: () => void;
    } = {},
): CodexSdkModule {
    let index = 0;
    const thread = (id: string | null): CodexThread => ({
        get id() {
            return id;
        },
        async runStreamed(_input, options) {
            seen.streamOptions = options;
            return {
                events: (async function* () {
                    try {
                        for await (const event of events(...(replies[index++] ?? []))) {
                            seen.onEvent?.(event);
                            yield event;
                        }
                    } finally {
                        seen.onClose?.();
                    }
                })(),
            };
        },
    });
    return {
        Codex: class {
            constructor(options: Record<string, unknown> = {}) {
                seen.options = options;
            }
            startThread(options?: CodexThreadOptions): CodexThread {
                seen.start = options;
                return thread(null);
            }
            resumeThread(id: string, options?: CodexThreadOptions): CodexThread {
                seen.resume = { id, options };
                return thread(id);
            }
        } as CodexSdkModule["Codex"],
    };
}

function baseArgs(sdk: CodexSdkModule, appended: AgentMessage[] = [], updates: string[] = []) {
    return {
        subSessionId,
        agentType: "codex-reviewer",
        prompt: "review it",
        cwd: "/work",
        config: { model: "gpt-6", sandbox: "read-only" as const, approvalPolicy: "never" as const },
        rolePrompt: "be precise",
        abortController: new AbortController(),
        appendMessages: async (messages: AgentMessage[]) => {
            appended.push(...messages);
        },
        onUpdate: ((update: { content: unknown }, options?: { checkpoint?: true }) => {
            updates.push(
                `${options?.checkpoint ? "checkpoint" : "live"}:${JSON.stringify(update.content)}`,
            );
        }) as SubagentProgressSink,
        loadSdk: async () => sdk,
    };
}

describe("runCodexSubagent", () => {
    it("reports a missing SDK as a readable failure", async () => {
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("unused")])),
            loadSdk: async () => {
                throw new Error("Codex SDK is not installed");
            },
        });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /Codex SDK is not installed/);
    });

    it("starts a thread with explicit options and persists the thread id before resumability", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const appended: AgentMessage[] = [];
        const eventsSeen: string[] = [];
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("done")], seen), appended, eventsSeen),
            onThreadId: async (id) => {
                await Promise.resolve();
                assert.equal(id, "thread-1");
                eventsSeen.push("saved");
            },
        });
        assert.equal(result.isError, false, result.resultText);
        assert.equal(result.resultText, "done");
        assert.deepEqual(seen.start, {
            workingDirectory: "/work",
            model: "gpt-6",
            sandboxMode: "read-only",
            approvalPolicy: "never",
            threadSource: "taco",
        });
        assert.deepEqual(seen.options?.config, {
            developer_instructions: "be precise",
        });
        assert.equal(typeof seen.options?.env, "object");
        assert.ok(
            eventsSeen.some((entry) => entry.includes("resume that session with chatToAgent")),
        );
        assert.deepEqual(
            appended.map((message) => message.role),
            ["user", "assistant"],
        );
    });

    it("resumes the exact native thread and never starts a fresh one", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const updates: string[] = [];
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("continued", "thread-existing")], seen), [], updates),
            resumeThreadId: "thread-existing",
        });
        assert.equal(result.isError, false, result.resultText);
        assert.equal(seen.start, undefined);
        assert.equal(seen.resume?.id, "thread-existing");
        assert.equal(seen.resume?.options?.workingDirectory, "/work");
        assert.ok(updates[0]?.includes("resume that session with chatToAgent"));
    });

    it("refuses to overwrite a saved mapping when resume reports another thread", async () => {
        let saved = 0;
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("wrong thread")])),
            resumeThreadId: "thread-existing",
            onThreadId: async () => {
                saved++;
            },
        });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /different native thread/);
        assert.equal(saved, 0);
    });

    it("rejects an empty resume id instead of starting a fresh thread", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("unused")], seen)),
            resumeThreadId: "   ",
        });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /resume state is invalid/);
        assert.equal(seen.start, undefined);
        assert.equal(seen.resume, undefined);
    });

    it("distinguishes a deliberate abort from a failure", async () => {
        const abortController = new AbortController();
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const sdk = fakeSdk(
            [
                [
                    { type: "thread.started", thread_id: "thread-1" },
                    {
                        type: "item.completed",
                        item: { id: "answer-1", type: "agent_message", text: "working" },
                    },
                ],
            ],
            seen,
        );
        seen.onEvent = (event) => {
            if (event.type === "item.completed") abortController.abort();
        };
        const result = await runCodexSubagent({
            ...baseArgs(sdk),
            abortController,
            loadSdk: async () => sdk,
        });
        assert.equal(result.isError, true);
        assert.equal(result.aborted, true);
        assert.match(result.resultText, /deliberate interruption/);
    });

    it("reports turn failure and preserves the saved recovery mapping", async () => {
        const result = await runCodexSubagent({
            ...baseArgs(
                fakeSdk([
                    [
                        { type: "thread.started", thread_id: "thread-1" },
                        {
                            type: "item.completed",
                            item: { id: "answer-1", type: "agent_message", text: "partial" },
                        },
                        { type: "turn.failed", error: { message: "provider failed" } },
                    ],
                ]),
            ),
            onThreadId: async () => {},
        });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /provider failed/);
        assert.match(result.resultText, /chatToAgent/);
    });

    it("closes the SDK stream when a turn fails", async () => {
        let closed = false;
        const seen: Parameters<typeof fakeSdk>[1] = {
            onClose: () => {
                closed = true;
            },
        };
        const result = await runCodexSubagent(
            baseArgs(fakeSdk([[{ type: "turn.failed", error: { message: "failed" } }]], seen)),
        );
        assert.equal(result.isError, true);
        assert.equal(closed, true);
    });

    it("closes the SDK stream when event iteration throws", async () => {
        let closed = false;
        const seen: Parameters<typeof fakeSdk>[1] = {
            onClose: () => {
                closed = true;
            },
            onEvent: (event) => {
                if (event.type === "thread.started") throw new Error("stream exploded");
            },
        };
        const result = await runCodexSubagent(
            baseArgs(fakeSdk([[{ type: "thread.started", thread_id: "thread-1" }]], seen)),
        );
        assert.equal(result.isError, true);
        assert.match(result.resultText, /stream exploded/);
        assert.equal(closed, true);
    });

    it("fails when the child transcript cannot be persisted", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        let calls = 0;
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("done")], seen)),
            appendMessages: async () => {
                calls++;
                if (calls > 1) throw new Error("disk full");
            },
        });
        assert.equal(result.isError, true);
        assert.match(result.resultText, /failed to persist.*disk full/);
        assert.equal(seen.start?.workingDirectory, "/work");
    });

    it("does not reject when a progress callback throws", async () => {
        const result = await runCodexSubagent({
            ...baseArgs(fakeSdk([answer("done")])),
            onUpdate: (() => {
                throw new Error("listener failed");
            }) as SubagentProgressSink,
        });
        assert.equal(result.isError, false, result.resultText);
        assert.equal(result.resultText, "done");
    });
});

it("round-trips the complete native Codex state", async () => {
    const values = new Map<object, unknown>();
    const session = {
        getValue: async (ref: object) => ({ value: values.get(ref) }),
        setValue: async (ref: object, next: unknown) => {
            values.set(ref, next);
        },
    } as unknown as Session;
    const state = {
        nativeThreadId: "thread-1",
        cwd: "/work",
        profileIdentity: "codex-reviewer",
        sdkVersion: "0.167.2",
        threadOptions: {
            model: "gpt-6",
            sandbox: "read-only" as const,
            approvalPolicy: "never" as const,
            skipGitRepoCheck: false,
        },
    };
    await writeCodexState(session, state);
    assert.deepEqual(await readCodexState(session), state);
    await writeCodexState(session, { ...state, nativeThreadId: "" } as CodexState);
    assert.equal(await readCodexState(session), undefined);
});

it("rejects a non-pinned Codex SDK version", () => {
    assert.doesNotThrow(() => assertCodexSdkVersion("0.167.2"));
    assert.throws(() => assertCodexSdkVersion("0.168.0"), CodexSdkVersionMismatchError);
});

it("validates package metadata before importing SDK module code", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-sdk-version-"));
    try {
        await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
        let imported = false;
        await assert.rejects(
            () =>
                loadCodexSdkEntry(join(root, "dist", "index.js"), root, async () => {
                    imported = true;
                    return {};
                }),
            CodexSdkVersionMismatchError,
        );
        assert.equal(imported, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
