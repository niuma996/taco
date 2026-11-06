import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { MemoryExtractorImpl } from "../../src/memory/local/extractor.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { AgentMessage, Api, Model, Models } from "../../src/runtime/pi/types.ts";

const evidence = "以后所有技术答复都先给结论，涉及方案决策时再解释取舍。";
function setup(actions: unknown[], existing: MemoryEntry[] = []) {
    const added: MemoryEntry[] = [];
    const updated: unknown[] = [];
    const calls: Array<{ systemPrompt: string; messages: Array<{ content: string }> }> = [];
    const extractor = new MemoryExtractorImpl(
        {
            completeSimple: async (_m: unknown, context: (typeof calls)[number]) => {
                calls.push(context);
                return {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: JSON.stringify(actions) }],
                };
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
const candidate = (overrides = {}) => ({
    action: "add",
    id: "reply-style",
    name: "答复风格",
    description: "技术答复先结论，决策解释取舍",
    type: "user",
    content: "技术答复先给结论。\n\n## 适用范围\n- 方案决策补充取舍。",
    basis: "durable_preference",
    evidence,
    ...overrides,
});
const user = (text = evidence, id = "user-entry") =>
    ({ role: "user", content: text, memoryEntryId: id }) as unknown as AgentMessage;

describe("automatic memory admission", () => {
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
                    return { role: "assistant", content: [{ type: "text", text: "[]" }] };
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
                completeSimple: async () => ({
                    role: "assistant",
                    content: [{ type: "text", text: JSON.stringify([candidate()]) }],
                }),
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
                return { role: "assistant", content: [{ type: "text", text: "[]" }] };
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

    it("rejects missing basis, missing evidence and evidence invented by the model", async () => {
        const { extractor, added } = setup([
            candidate({ basis: undefined }),
            candidate({ evidence: undefined }),
            candidate({ evidence: "助手建议使用 React" }),
        ]);
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
                return { role: "assistant", content: [{ type: "text", text: "[]" }] };
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
                    return { role: "assistant", content: [{ type: "text", text: "[]" }] };
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
                    return {
                        role: "assistant",
                        content: [{ type: "text", text: calls === 1 ? "broken result" : "[]" }],
                    };
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
