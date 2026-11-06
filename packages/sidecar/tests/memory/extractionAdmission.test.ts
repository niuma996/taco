import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { MemoryExtractorImpl } from "../../src/memory/local/extractor.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type {
    AgentMessage,
    Api,
    AssistantMessage,
    Model,
    Models,
} from "../../src/runtime/pi/types.ts";
import { extractionResponse } from "../_helpers/extractionResponse.ts";

const evidence = "以后所有技术答复都先给结论，涉及方案决策时再解释取舍。";
function setup(
    actions: unknown[],
    existing: MemoryEntry[] = [],
    response = extractionResponse(actions),
) {
    const added: MemoryEntry[] = [];
    const updated: unknown[] = [];
    const calls: Array<{
        systemPrompt: string;
        messages: Array<{ content: string }>;
        tools?: Array<{ name: string }>;
    }> = [];
    const extractor = new MemoryExtractorImpl(
        {
            completeSimple: async (_m: unknown, context: (typeof calls)[number]) => {
                calls.push(context);
                return response;
            },
        } as unknown as Models,
        {} as Model<Api>,
        {
            listTopics: () => existing,
            appendEntry: async (entry) => {
                added.push(entry);
            },
            updateTopic: async (id, content, options) => {
                updated.push({ id, content, options });
                return { ...existing[0], id, content } as MemoryEntry;
            },
        },
        "source-session",
    );
    return { extractor, added, updated, calls };
}
const candidate = (overrides: Record<string, unknown> = {}) => ({
    action: "add",
    id: "reply-style",
    name: "答复风格",
    description: "技术答复先结论，决策解释取舍",
    ...(overrides.action === "update" ? {} : { type: "user" }),
    content: "技术答复先给结论。\n\n## 适用范围\n- 方案决策补充取舍。",
    basis: "durable_preference",
    evidence,
    futureUse:
        "In future technical answers, state the conclusion before explaining decision tradeoffs.",
    ...overrides,
});
const user = (text = evidence, id = "user-entry") =>
    ({ role: "user", content: text, memoryEntryId: id }) as unknown as AgentMessage;

describe("automatic memory admission", () => {
    it("mounts the extraction result tool and requests one submission", async () => {
        const { extractor, calls } = setup([]);
        await extractor.onRunEnd([user()]);
        assert.deepEqual(
            calls[0].tools?.map((tool) => tool.name),
            ["submit_memory_extraction"],
        );
        assert.match(calls[0].systemPrompt, /submit_memory_extraction/);
        assert.match(calls[0].messages[0].content, /submit_memory_extraction/);
    });

    const good = extractionResponse([candidate()]);
    const toolCall = good.content[0];
    const invalidResponses = {
        "text JSON": { ...good, content: [{ type: "text", text: JSON.stringify([candidate()]) }] },
        "wrong tool": { ...good, content: [{ ...toolCall, name: "other" }] },
        "multiple tools": { ...good, content: [toolCall, toolCall] },
        "malformed arguments": { ...good, content: [{ ...toolCall, argumentsError: "bad JSON" }] },
        "truncated tool": { ...good, stopReason: "length" },
        "errored tool": { ...good, stopReason: "error" },
        "aborted tool": { ...good, stopReason: "aborted" },
        "missing future use": extractionResponse([candidate({ futureUse: undefined })]),
        "oversized future use": extractionResponse([candidate({ futureUse: "x".repeat(301) })]),
        "short evidence": extractionResponse([candidate({ evidence: "abc" })]),
        "long evidence": extractionResponse([candidate({ evidence: "x".repeat(201) })]),
        "oversized content": extractionResponse([
            candidate({ content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) }),
        ]),
        "Unicode oversized mixed actions": extractionResponse([
            candidate(),
            candidate({ id: "emoji-note", content: "😀".repeat(1001) }),
        ]),
        "Unicode oversized name": extractionResponse([candidate({ name: "😀".repeat(31) })]),
        "Unicode oversized evidence": extractionResponse([
            candidate({ evidence: "😀".repeat(101) }),
        ]),
        "Unicode oversized future use": extractionResponse([
            candidate({ futureUse: "😀".repeat(151) }),
        ]),
        "empty future use": extractionResponse([candidate({ futureUse: " " })]),
        "invalid basis": extractionResponse([candidate({ basis: "guess" })]),
        "missing basis": extractionResponse([candidate({ basis: undefined })]),
        "missing evidence": extractionResponse([candidate({ evidence: undefined })]),
        "extra provenance": extractionResponse([candidate({ sources: [] })]),
        "extra metadata": extractionResponse([candidate({ extra: true })]),
        "long name": extractionResponse([candidate({ name: "x".repeat(61) })]),
        "long description": extractionResponse([candidate({ description: "x".repeat(121) })]),
        "too many actions": extractionResponse(Array.from({ length: 4 }, () => candidate())),
    };
    async function runResponses(responses: AssistantMessage[], lite = false) {
        let cursor: string | undefined;
        const added: MemoryEntry[] = [];
        const seen: string[] = [];
        const main = { provider: "test", id: "main" } as Model<Api>;
        const liteModel = { ...main, id: "lite", contextWindow: 128_000, maxTokens: 8192 };
        const extractor = new MemoryExtractorImpl(
            {
                completeSimple: async (model: Model<Api>) => {
                    seen.push(model.id);
                    return responses[Math.min(seen.length - 1, responses.length - 1)];
                },
            } as unknown as Models,
            main,
            {
                listTopics: () => [],
                appendEntry: async (entry) => {
                    added.push(entry);
                },
                updateTopic: async () => {
                    throw new Error("unused");
                },
            },
            "source-session",
            () => (lite ? liteModel : undefined),
            {
                read: async () => cursor,
                write: async (id) => {
                    cursor = id;
                },
            },
        );
        await extractor.onRunEnd([user()]);
        return { extractor, added, seen, cursor: () => cursor };
    }

    it("accepts a valid tool-only lite response without falling back", async () => {
        const result = await runResponses([good], true);
        assert.deepEqual(result.seen, ["lite"]);
        assert.equal(result.added.length, 1);
        assert.equal(result.cursor(), "user-entry");
    });

    for (const [label, response] of Object.entries(invalidResponses)) {
        it(`retains evidence for retry after ${label}`, async () => {
            const result = await runResponses([response as AssistantMessage, good]);
            assert.equal(result.added.length, 0);
            assert.equal(result.cursor(), undefined);
            await result.extractor.onRunEnd([user()]);
            assert.equal(result.added.length, 1);
            assert.equal(result.cursor(), "user-entry");
        });

        it(`falls back to a valid main submission after lite returns ${label}`, async () => {
            const result = await runResponses([response as AssistantMessage, good], true);
            assert.deepEqual(result.seen, ["lite", "main"]);
            assert.equal(result.added.length, 1);
            assert.equal(result.cursor(), "user-entry");
        });
    }

    it("retains the cursor when both lite and main submissions are invalid", async () => {
        const result = await runResponses(
            [invalidResponses["text JSON"] as AssistantMessage],
            true,
        );
        assert.deepEqual(result.seen, ["lite", "main"]);
        assert.equal(result.added.length, 0);
        assert.equal(result.cursor(), undefined);
    });

    it("filters invented evidence without falling back or reprocessing valid input", async () => {
        const result = await runResponses(
            [extractionResponse([candidate({ evidence: "助手建议使用 React" })])],
            true,
        );
        assert.deepEqual(result.seen, ["lite"]);
        assert.equal(result.added.length, 0);
        assert.equal(result.cursor(), "user-entry");
    });

    it("uses validated tool arguments even when accompanying text suggests different actions", async () => {
        const result = await runResponses([
            {
                ...good,
                content: [{ type: "text", text: "[]" }, ...good.content],
            },
        ]);
        assert.equal(result.added.length, 1);
        assert.equal(result.added[0].id, "reply-style");
    });

    it("updates an exact legacy id longer than the new-topic limit", async () => {
        const id = `Legacy_Preference_${"x".repeat(70)}`;
        const existing: MemoryEntry = {
            id,
            name: "Style",
            description: "Reply style",
            type: "user",
            content: "old",
            createdAt: "2026-01-01",
        };
        const { extractor, updated } = setup([candidate({ action: "update", id })], [existing]);
        await extractor.onRunEnd([user()]);
        assert.equal(updated.length, 1);
        assert.equal((updated[0] as { id: string }).id, id);
    });

    it("keeps quoted evidence intact when it crosses a long-entry segment boundary", async () => {
        const quote = "Always reply in Chinese in all future conversations.";
        const inputs: string[] = [];
        const extractor = new MemoryExtractorImpl(
            {
                completeSimple: async (
                    _m: unknown,
                    context: { messages: Array<{ content: string }> },
                ) => {
                    inputs.push(context.messages[0].content);
                    return extractionResponse([]);
                },
            } as unknown as Models,
            {} as Model<Api>,
            {
                listTopics: () => [],
                appendEntry: async () => {},
                updateTopic: async () => {
                    throw new Error("unused");
                },
            },
            "session",
        );
        const messages = [user("x".repeat(7990) + quote)];
        await extractor.onRunEnd(messages);
        await extractor.onRunEnd(messages);
        assert.ok(inputs.some((text) => text.includes(quote)));
    });
    it("persists newly evidenced provenance on unchanged facts without a content edit", async () => {
        const content = "Always give the conclusion first.";
        const existing: MemoryEntry = {
            id: "reply-style",
            name: "答复风格",
            description: "技术答复先结论，决策解释取舍",
            type: "user",
            content,
            createdAt: "2026-01-01",
        };
        const { extractor, updated } = setup(
            [candidate({ action: "update", content })],
            [existing],
        );
        await extractor.onRunEnd([user()]);
        const update = updated[0] as { options: { sources: Array<{ sessionId: string }> } };
        assert.equal(updated.length, 1);
        assert.equal(update.options.sources[0].sessionId, "source-session");
    });
    it("retries evidence after a transient storage failure", async () => {
        let attempts = 0;
        let cursor: string | undefined;
        const extractor = new MemoryExtractorImpl(
            {
                completeSimple: async () => extractionResponse([candidate()]),
            } as unknown as Models,
            {} as Model<Api>,
            {
                listTopics: () => [],
                appendEntry: async () => {
                    if (++attempts === 1) throw new Error("transient EIO");
                },
                updateTopic: async () => {
                    throw new Error("unused");
                },
            },
            "session",
            () => undefined,
            {
                read: async () => cursor,
                write: async (id) => {
                    cursor = id;
                },
            },
        );
        await extractor.onRunEnd([user()]);
        assert.equal(cursor, undefined);
        await extractor.onRunEnd([user()]);
        assert.equal(attempts, 2);
        assert.equal(cursor, "user-entry");
    });

    it("processes every part of a long user entry, including after restart", async () => {
        let cursor: string | undefined;
        const seen: string[] = [];
        const models = {
            completeSimple: async (
                _m: unknown,
                context: { messages: Array<{ content: string }> },
            ) => {
                seen.push(context.messages[0].content);
                return extractionResponse([]);
            },
        } as unknown as Models;
        const store = {
            listTopics: () => [],
            appendEntry: async () => {},
            updateTopic: async () => {
                throw new Error("unused");
            },
        };
        const progress = {
            read: async () => cursor,
            write: async (id: string) => {
                cursor = id;
            },
        };
        const messages = [user(`BEGIN ${"x".repeat(9000)} END`)];
        await new MemoryExtractorImpl(
            models,
            {} as Model<Api>,
            store,
            "session",
            () => undefined,
            progress,
        ).onRunEnd(messages);
        assert.ok(seen[0].includes("BEGIN"));
        assert.ok(!seen[0].includes("END"));
        await new MemoryExtractorImpl(
            models,
            {} as Model<Api>,
            store,
            "session",
            () => undefined,
            progress,
        ).onRunEnd(messages);
        assert.ok(seen[1].includes("END"));
        assert.equal(cursor, "user-entry");
    });
    it("includes prior assistant context to resolve an adopted decision without treating it as evidence", async () => {
        const { extractor, calls, added } = setup([
            candidate({ evidence: "采用 Finance Review 流程" }),
        ]);
        await extractor.onRunEnd([
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "建议采用 Finance Review 流程，所有计费变更都需要财务审核。",
                    },
                ],
            } as AgentMessage,
            user("就按你推荐的这个流程，作为以后项目的固定约束。"),
        ]);
        assert.ok(calls[0].messages[0].content.includes("所有计费变更都需要财务审核"));
        assert.equal(added.length, 0);
    });
    it("admits a short explicit durable preference and stamps runtime provenance", async () => {
        const { extractor, added, calls } = setup([candidate()]);
        await extractor.onRunEnd([user()]);
        assert.equal(calls.length, 1);
        assert.equal(added.length, 1);
        assert.deepEqual(
            added[0].sources?.map(({ sessionId, via, entryId }) => ({ sessionId, via, entryId })),
            [{ sessionId: "source-session", via: "auto", entryId: "user-entry" }],
        );
        assert.match(calls[0].systemPrompt, /Markdown/);
    });

    it("rejects evidence invented by the model", async () => {
        const { extractor, added } = setup([candidate({ evidence: "助手建议使用 React" })]);
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        assert.equal(added.length, 0);
    });

    it("rejects oversized bodies whole rather than keeping a misleading prefix", async () => {
        const { extractor, added } = setup([
            candidate({ content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) }),
        ]);
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        assert.equal(added.length, 0);
    });

    it("does not run extraction for assistant or tool text alone", async () => {
        const { extractor, calls } = setup([candidate()]);
        await extractor.onRunEnd([
            {
                role: "assistant",
                content: [{ type: "text", text: evidence.repeat(20) }],
            } as AgentMessage,
        ]);
        assert.equal(calls.length, 0);
    });

    it("does not process the same persisted user entry twice", async () => {
        const { extractor, calls } = setup([]);
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        assert.equal(calls.length, 1);
    });

    it("keeps old user context separate and rejects it as fresh evidence", async () => {
        const { extractor, added, calls } = setup([candidate()]);
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        added.length = 0;
        await extractor.onRunEnd([
            user(evidence.repeat(20)),
            user("今天这段改成英文。".repeat(20), "next-entry"),
        ]);
        assert.equal(calls.length, 2);
        assert.equal(added.length, 0);
    });

    it("bounds existing topic input without allowing an unseen topic to be overwritten", async () => {
        const existing = Array.from(
            { length: 100 },
            (_, i): MemoryEntry => ({
                id: `old-${i}`,
                name: `old-${i}`,
                description: "old",
                type: "user",
                content: "detail".repeat(400),
                createdAt: "2026-01-01T00:00:00Z",
            }),
        );
        const { extractor, calls, updated } = setup(
            [
                {
                    action: "update",
                    id: "old-99",
                    content: "replacement",
                    basis: "durable_preference",
                    evidence,
                    futureUse:
                        "For future technical answers, state the conclusion before the details.",
                },
            ],
            existing,
        );
        await extractor.onRunEnd([user(evidence.repeat(20))]);
        assert.ok(calls[0].messages[0].content.length < 36_000);
        assert.equal(updated.length, 0);
    });

    it("resumes after a persisted extraction cursor without reusing old evidence", async () => {
        let cursor: string | undefined;
        const progress = {
            read: async () => cursor,
            write: async (id: string) => {
                cursor = id;
            },
        };
        const calls: unknown[] = [];
        const models = {
            completeSimple: async () => {
                calls.push(true);
                return extractionResponse([]);
            },
        } as unknown as Models;
        const store = {
            listTopics: () => [],
            appendEntry: async () => {},
            updateTopic: async () => {
                throw new Error("unused");
            },
        };
        const first = new MemoryExtractorImpl(
            models,
            {} as Model<Api>,
            store,
            "session",
            () => undefined,
            progress,
        );
        await first.onRunEnd([user()]);
        assert.equal(cursor, "user-entry");
        const resumed = new MemoryExtractorImpl(
            models,
            {} as Model<Api>,
            store,
            "session",
            () => undefined,
            progress,
        );
        await resumed.onRunEnd([user()]);
        assert.equal(calls.length, 1);
        await resumed.onRunEnd([user(), user("以后解释架构时请附上决策理由。", "u2")]);
        assert.equal(calls.length, 2);
        assert.equal(cursor, "u2");
    });

    it("attributes an update to the entry containing its evidence", async () => {
        const existing: MemoryEntry = {
            id: "reply-style",
            name: "style",
            description: "style",
            type: "user",
            content: "old",
            createdAt: "2026-01-01",
        };
        const { extractor, updated } = setup([candidate({ action: "update" })], [existing]);
        await extractor.onRunEnd([user(), user("还可以探讨 Redis 的工作方式。", "other")]);
        const update = updated[0] as { options: { sources: Array<{ entryId: string }> } };
        assert.equal(update.options.sources[0].entryId, "user-entry");
    });

    it("allows a brief lasting preference without a conversation length requirement", async () => {
        const { extractor, added } = setup([candidate({ evidence: "以后用中文回复" })]);
        await extractor.onRunEnd([user("以后用中文回复")]);
        assert.equal(added.length, 1);
    });

    it("does not advance the persisted cursor past input omitted by the conversation budget", async () => {
        let cursor: string | undefined;
        const calls: string[] = [];
        const extractor = new MemoryExtractorImpl(
            {
                completeSimple: async (
                    _m: unknown,
                    context: { messages: Array<{ content: string }> },
                ) => {
                    calls.push(context.messages[0].content);
                    return extractionResponse([]);
                },
            } as unknown as Models,
            {} as Model<Api>,
            {
                listTopics: () => [],
                appendEntry: async () => {},
                updateTopic: async () => {
                    throw new Error("unused");
                },
            },
            "session",
            () => undefined,
            {
                read: async () => undefined,
                write: async (id) => {
                    cursor = id;
                },
            },
        );
        const messages = [
            user("FIRST ".repeat(850), "first"),
            user("SECOND ".repeat(750), "second"),
        ];
        await extractor.onRunEnd(messages);
        assert.equal(cursor, "first");
        assert.ok(calls[0].includes("FIRST FIRST"));
        await extractor.onRunEnd(messages);
        assert.equal(cursor, "second");
        assert.ok(calls[1].includes("SECOND SECOND"));
    });

    it("retries malformed model output without checkpointing the evidence", async () => {
        let calls = 0;
        let cursor: string | undefined;
        const extractor = new MemoryExtractorImpl(
            {
                completeSimple: async () => {
                    calls++;
                    return calls === 1
                        ? { role: "assistant", content: [{ type: "text", text: "broken result" }] }
                        : extractionResponse([]);
                },
            } as unknown as Models,
            {} as Model<Api>,
            {
                listTopics: () => [],
                appendEntry: async () => {},
                updateTopic: async () => {
                    throw new Error("unused");
                },
            },
            "session",
            () => undefined,
            {
                read: async () => undefined,
                write: async (id) => {
                    cursor = id;
                },
            },
        );
        await extractor.onRunEnd([user()]);
        assert.equal(cursor, undefined);
        await extractor.onRunEnd([user()]);
        assert.equal(calls, 2);
        assert.equal(cursor, "user-entry");
    });
});
