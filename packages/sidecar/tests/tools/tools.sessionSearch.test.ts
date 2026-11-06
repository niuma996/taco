// sessionSearch / sessionList: user-question extraction, coverage reporting,
// truncation, and the local-main-session boundary.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId, asWorkspaceId, type SessionListEntry } from "@taco-ai/protocol";
import {
    readUserQuestionsFromDisk,
    UserQuestionCache,
    userQuestionFromRecord,
} from "../../src/runtime/session/sessionQuestions.ts";
import type { TacoToolContext } from "../../src/tools/context.ts";
import {
    createSessionListTool,
    createSessionSearchTool,
    sessionHistoryToolCandidates,
    snippetAround,
} from "../../src/tools/sessionSearch.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { sessionToolContext } from "../_helpers/toolContext.ts";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const DAY = 86_400_000;

function header(id: string): string {
    return JSON.stringify({
        v: 4,
        kind: "header",
        id,
        storageVersion: 1,
        createdAt: T0,
        cwd: "/ws",
    });
}

function userEntry(at: number, content: unknown): string {
    return JSON.stringify({
        kind: "entry",
        type: "message",
        id: `e${at}`,
        parentId: null,
        seq: 1,
        timestamp: at,
        message: { role: "user", content, timestamp: at },
    });
}

function assistantEntry(at: number, text: string): string {
    return JSON.stringify({
        kind: "entry",
        type: "message",
        id: `a${at}`,
        parentId: null,
        seq: 2,
        timestamp: at,
        message: { role: "assistant", content: [{ type: "text", text }] },
    });
}

let dir: string;
before(() => {
    dir = mkdtempSync(join(tmpdir(), "taco-session-search-"));
});
after(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeSession(name: string, lines: string[]): string {
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

function entry(id: string, filePath: string, at: number, name?: string): SessionListEntry {
    return {
        id: asSessionId(id),
        cwd: asWorkspaceId("/ws"),
        filePath,
        createdAt: new Date(at).toISOString(),
        updatedAt: new Date(at).toISOString(),
        kind: "main",
        ...(name ? { name } : {}),
    };
}

function ctxWith(sessions: SessionListEntry[], overrides: Partial<TacoToolContext> = {}) {
    const calls: string[] = [];
    const ctx = sessionToolContext({
        workspace: asWorkspaceId("/ws"),
        sessionId: asSessionId("current"),
        call: async <P, R>(method: string, _ws: string, _params: P): Promise<R> => {
            calls.push(method);
            return { workspace: "/ws", sessions, total: sessions.length } as R;
        },
        ...overrides,
    });
    return { ctx, calls };
}

function text(result: { content: { type: string; text?: string }[] }): string {
    return result.content.map((c) => c.text ?? "").join("\n");
}

describe("userQuestionFromRecord", () => {
    it("returns the text of a plain user message", () => {
        const q = userQuestionFromRecord(
            JSON.parse(userEntry(T0, [{ type: "text", text: "  hi  " }])),
        );
        assert.deepEqual(q, { at: T0, text: "hi" });
    });

    it("accepts string content and v3 ISO timestamps", () => {
        const q = userQuestionFromRecord({
            type: "message",
            timestamp: new Date(T0).toISOString(),
            message: { role: "user", content: "legacy question" },
        });
        assert.deepEqual(q, { at: T0, text: "legacy question" });
    });

    it("ignores assistant messages", () => {
        assert.equal(userQuestionFromRecord(JSON.parse(assistantEntry(T0, "reply"))), undefined);
    });

    it("drops synthetic user messages wrapped in hidden tags", () => {
        const askUser = "<ask_user_context>\nThe user has answered\n</ask_user_context>";
        const notice = '<subagent_result agent-type="x">finished</subagent_result>';
        assert.equal(userQuestionFromRecord(JSON.parse(userEntry(T0, askUser))), undefined);
        assert.equal(
            userQuestionFromRecord(JSON.parse(userEntry(T0, [{ type: "text", text: notice }]))),
            undefined,
        );
    });

    it("keeps user text around a hidden tag and skips image-only messages", () => {
        const mixed = "how do I configure auth? <reply_language>zh</reply_language>";
        assert.equal(
            userQuestionFromRecord(JSON.parse(userEntry(T0, mixed)))?.text,
            "how do I configure auth?",
        );
        const image = [{ type: "image", data: "AAA", mimeType: "image/png" }];
        assert.equal(userQuestionFromRecord(JSON.parse(userEntry(T0, image))), undefined);
    });
});

describe("readUserQuestionsFromDisk", () => {
    it("reads batched lines, survives a torn last line, sorts oldest first", async () => {
        const batched = `[${userEntry(T0 + 2, "second")},${assistantEntry(T0 + 3, "r")}]`;
        const path = join(dir, "torn.jsonl");
        writeFileSync(
            path,
            [header("s"), userEntry(T0 + 5, "third"), batched, userEntry(T0 + 1, "first")].join(
                "\n",
            ) + '\n{"kind":"entry","type":"message","message":{"role":"user"',
        );
        const qs = await readUserQuestionsFromDisk(path);
        assert.deepEqual(
            qs.map((q) => q.text),
            ["first", "second", "third"],
        );
    });
});

describe("UserQuestionCache", () => {
    it("re-reads only when the file changes", async () => {
        const path = writeSession("cache", [header("c"), userEntry(T0, "one")]);
        const cache = new UserQuestionCache();
        const first = await cache.read(path);
        assert.equal(await cache.read(path), first, "unchanged file must hit the cache");
        writeFileSync(
            path,
            `${[header("c"), userEntry(T0, "one"), userEntry(T0 + 1, "two")].join("\n")}\n`,
        );
        utimesSync(path, new Date(), new Date(Date.now() + 5000));
        const second = await cache.read(path);
        assert.deepEqual(
            second.map((q) => q.text),
            ["one", "two"],
        );
    });
});

describe("sessionSearch", () => {
    it("matches any keyword case-insensitively and reports coverage per keyword", async () => {
        const a = writeSession("a", [
            header("a"),
            userEntry(T0, "How do I set up OAuth login?"),
            assistantEntry(T0 + 1, "oauth answer — must not be searched"),
            userEntry(T0 + DAY, "unrelated question"),
        ]);
        const b = writeSession("b", [header("b"), userEntry(T0 + 2 * DAY, "鉴权失败怎么排查")]);
        const { ctx } = ctxWith([entry("a", a, T0 + DAY, "Login"), entry("b", b, T0 + 2 * DAY)]);
        const out = text(
            await invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["oauth", "鉴权", "kerberos"] },
                ctx,
            ),
        );
        assert.match(out, /Scanned 3 questions in 2 past sessions/);
        assert.match(out, /oauth \(1\), 鉴权 \(1\), kerberos \(0\)/);
        assert.match(out, /2 matching questions in 2 sessions/);
        // newest first
        assert.ok(out.indexOf("鉴权失败") < out.indexOf("OAuth login"));
        assert.doesNotMatch(out, /must not be searched/);
    });

    it("excludes the current session", async () => {
        const cur = writeSession("cur", [
            header("current"),
            userEntry(T0, "have I asked about oauth?"),
        ]);
        const { ctx } = ctxWith([entry("current", cur, T0)]);
        const out = text(
            await invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["oauth"] },
                ctx,
            ),
        );
        assert.match(out, /Scanned 0 questions in 0 past sessions/);
        assert.match(out, /No question in this range/);
    });

    it("applies since/until to question time, not session time", async () => {
        const p = writeSession("range", [
            header("r"),
            userEntry(T0, "old oauth question"),
            userEntry(T0 + 10 * DAY, "new oauth question"),
        ]);
        const { ctx } = ctxWith([entry("r", p, T0 + 10 * DAY)]);
        const out = text(
            await invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["oauth"], since: new Date(T0 + 5 * DAY).toISOString() },
                ctx,
            ),
        );
        assert.match(out, /Scanned 1 questions/);
        assert.match(out, /new oauth question/);
        assert.doesNotMatch(out, /old oauth question/);
    });

    it("truncates shown hits but keeps the full count", async () => {
        const lines = [header("t")];
        for (let i = 0; i < 5; i++) lines.push(userEntry(T0 + i, `oauth #${i}`));
        const p = writeSession("trunc", lines);
        const { ctx } = ctxWith([entry("t", p, T0)]);
        const out = text(
            await invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["oauth"], maxResults: 2 },
                ctx,
            ),
        );
        assert.match(out, /5 matching questions/);
        assert.match(out, /… \(3 more/);
        assert.match(out, /oauth #4/);
        assert.doesNotMatch(out, /oauth #0/);
    });

    it("reports unreadable session files instead of silently skipping them", async () => {
        const { ctx } = ctxWith([entry("gone", join(dir, "missing.jsonl"), T0)]);
        const out = text(
            await invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["x"] },
                ctx,
            ),
        );
        assert.match(out, /1 session file\(s\) could not be read/);
    });

    it("rejects an invalid date", async () => {
        const { ctx } = ctxWith([]);
        await assert.rejects(
            invokeTool(
                createSessionSearchTool(new UserQuestionCache()),
                { keywords: ["x"], since: "last week" },
                ctx,
            ),
            /not a valid ISO date/,
        );
    });

    for (const [label, overrides] of [
        ["IM sessions", { isIm: true }],
        ["subagents", { sessionKind: "subagent" as const }],
    ] as const) {
        it(`refuses ${label} without reading anything`, async () => {
            const { ctx, calls } = ctxWith([], overrides);
            await assert.rejects(
                invokeTool(
                    createSessionSearchTool(new UserQuestionCache()),
                    { keywords: ["x"] },
                    ctx,
                ),
                /not available here/,
            );
            await assert.rejects(
                invokeTool(createSessionListTool(new UserQuestionCache()), {}, ctx),
                /not available here/,
            );
            assert.deepEqual(calls, []);
        });
    }
});

describe("sessionList", () => {
    it("pages sessions with a first-question excerpt and transcript path", async () => {
        const sessions = [0, 1, 2].map((i) =>
            entry(
                `s${i}`,
                writeSession(`list${i}`, [
                    header(`s${i}`),
                    userEntry(T0 + i, `first question ${i}`),
                ]),
                T0 + (3 - i) * DAY,
                `Title ${i}`,
            ),
        );
        const { ctx } = ctxWith(sessions);
        const out = text(
            await invokeTool(createSessionListTool(new UserQuestionCache()), { limit: 2 }, ctx),
        );
        assert.match(out, /3 past sessions in range .* showing 1–2/);
        assert.match(out, /Title 0[\s\S]*first question: first question 0/);
        assert.match(out, /transcript: .*list0\.jsonl/);
        assert.doesNotMatch(out, /Title 2/);
        assert.match(out, /1 more\. Fetch another page only if/);
    });
});

describe("snippetAround", () => {
    it("keeps short text whole and windows long text around the match", () => {
        assert.equal(snippetAround("short  text", 0), "short text");
        const long = `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`;
        const s = snippetAround(long, 300);
        assert.ok(s.includes("NEEDLE"));
        assert.ok(s.startsWith("…") && s.endsWith("…"));
    });
});

describe("sessionHistoryToolCandidates", () => {
    it("offers recall tools as deferred builtins", () => {
        const c = sessionHistoryToolCandidates();
        assert.deepEqual(
            c.map((x) => [x.name, x.loading, x.source]),
            [
                ["sessionSearch", "deferred", "builtin"],
                ["sessionList", "deferred", "builtin"],
                ["sessionRead", "deferred", "builtin"],
            ],
        );
        assert.match(c[1]?.summary ?? "", /Last resort/);
    });
});

describe("sessionRead", () => {
    const historyEntry = (id: string, role: string, content: unknown, type = "message") => ({
        id,
        parentId: null,
        type,
        timestamp: new Date(T0).toISOString(),
        payload: { role, content, apiKey: "payload-secret" },
    });
    async function readTool() {
        const candidate = sessionHistoryToolCandidates().find((c) => c.name === "sessionRead");
        assert.ok(candidate, "sessionRead must be discoverable as a deferred tool");
        return candidate.load();
    }
    function readContext(
        entries: unknown[],
        sessions = [entry("target", "/never/read.jsonl", T0)],
    ) {
        const calls: { method: string; params: Record<string, unknown> }[] = [];
        const ctx = sessionToolContext({
            workspace: asWorkspaceId("/ws"),
            call: async <P, R>(method: string, _ws: string, params: P): Promise<R> => {
                calls.push({ method, params: params as Record<string, unknown> });
                if (method === "session.list")
                    return { workspace: "/ws", sessions, total: sessions.length } as R;
                if (method === "session.history")
                    return { sessionId: "target", leafEntryId: null, entries } as R;
                throw new Error("unexpected RPC");
            },
        });
        return { ctx, calls };
    }
    const page = (result: Parameters<typeof text>[0]) => JSON.parse(text(result));

    it("reads actual history payloads, exposing only visible user and assistant text", async () => {
        const { ctx, calls } = readContext([
            historyEntry("u", "user", "question <reply_language>zh</reply_language>"),
            historyEntry("a", "assistant", [
                { type: "thinking", thinking: "thinking-secret" },
                { type: "text", text: "answer" },
                { type: "toolCall", arguments: { token: "tool-secret" } },
            ]),
            historyEntry("t", "toolResult", "tool-result-secret"),
            historyEntry("s", "system", "system-secret"),
            historyEntry("c", "assistant", "summary-secret", "compaction"),
            historyEntry("i", "user", [{ type: "image", data: "image-secret" }]),
        ]);
        const out = await invokeTool(await readTool(), { sessionId: "target" }, ctx);
        const data = page(out);
        assert.deepEqual(
            data.messages.map((m: { role: string; text: string }) => [m.role, m.text]),
            [
                ["user", "question "],
                ["assistant", "answer"],
            ],
        );
        assert.doesNotMatch(text(out), /secret|reply_language|never\/read/);
        assert.equal(data.nextOffset, null);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.list", "session.history"],
        );
        assert.equal(calls[0]?.params.query, "target");
        assert.ok(Number(calls[0]?.params.limit) <= 50);
        assert.notEqual(calls[0]?.params.full, true);
        assert.deepEqual(calls[1]?.params, { workspace: "/ws", sessionId: "target" });
    });

    it("pages losslessly through huge messages and advances to later messages", async () => {
        const huge = "😀".repeat(30_000) + "THE END";
        const { ctx } = readContext([
            historyEntry("big", "assistant", huge),
            historyEntry("last", "user", "follow up"),
        ]);
        const tool = await readTool();
        let offset = 0;
        let reconstructed = "";
        let sawLast = false;
        for (let n = 0; n < 100; n++) {
            const out = await invokeTool(tool, { sessionId: "target", offset, limit: 2 }, ctx);
            assert.ok(text(out).length < 25_000, "each response is bounded");
            const data = page(out);
            assert.ok(data.messages.length <= 2);
            for (const message of data.messages) {
                if (message.entryId === "big") reconstructed += message.text;
                if (message.entryId === "last") sawLast = true;
            }
            if (data.nextOffset === null) break;
            assert.ok(data.nextOffset > offset, "pagination must make progress");
            offset = data.nextOffset;
        }
        assert.equal(reconstructed, huge);
        assert.equal(sawLast, true);
    });

    it("bounds default output, explicit large limits, and metadata", async () => {
        const sessions = [entry("target", "/private/path", T0, "title".repeat(30_000))];
        const { ctx } = readContext(
            [historyEntry("x".repeat(40_000), "assistant", "a".repeat(100_000))],
            sessions,
        );
        for (const params of [{ sessionId: "target" }, { sessionId: "target", limit: 10 }]) {
            const out = await invokeTool(await readTool(), params, ctx);
            assert.ok(text(out).length < 25_000);
            assert.ok(JSON.stringify(out.details).length < 25_000);
            assert.ok(page(out).nextOffset > 0);
        }
    });

    for (const overrides of [{ isIm: true }, { sessionKind: "subagent" as const }]) {
        it(`refuses unauthorized caller ${JSON.stringify(overrides)} before RPC`, async () => {
            const { ctx, calls } = readContext([]);
            await assert.rejects(
                invokeTool(await readTool(), { sessionId: "target" }, { ...ctx, ...overrides }),
                /local main session/,
            );
            assert.deepEqual(calls, []);
        });
    }
    for (const sessions of [
        [],
        [entry("target-prefix", "/path", T0)],
        [{ ...entry("target", "/path", T0), cwd: asWorkspaceId("/other") }],
        [{ ...entry("target", "/path", T0), kind: "subagent" as const }],
        [{ ...entry("target", "/path", T0), parentSessionId: asSessionId("parent") }],
    ]) {
        it(`rejects absent, prefix, foreign, or hidden targets ${JSON.stringify(sessions.map((s) => [s.id, s.cwd, s.kind, s.parentSessionId]))}`, async () => {
            const { ctx, calls } = readContext([], sessions);
            await assert.rejects(
                invokeTool(await readTool(), { sessionId: "target" }, ctx),
                /not found|unavailable/i,
            );
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.list"],
            );
        });
    }
    it("reports a deleted transcript without leaking the internal RPC error", async () => {
        const { ctx } = readContext([]);
        const call = ctx.call;
        assert.ok(call);
        ctx.call = async (method, workspace, params) => {
            if (method === "session.history")
                throw new Error("ENOENT /private/transcript.jsonl token-secret");
            return call(method, workspace, params);
        };
        await assert.rejects(
            invokeTool(await readTool(), { sessionId: "target" }, ctx),
            (error: Error) => {
                assert.match(error.message, /unavailable|deleted/i);
                assert.doesNotMatch(error.message, /private|secret/);
                return true;
            },
        );
    });
    it("keeps escaped control-character pages bounded and lossless", async () => {
        const original = '\u0000\\"\n'.repeat(10_000);
        const { ctx } = readContext([historyEntry("escaped", "assistant", original)]);
        const tool = await readTool();
        let offset = 0;
        let reconstructed = "";
        for (let n = 0; n < 100; n++) {
            const out = await invokeTool(tool, { sessionId: "target", offset }, ctx);
            assert.ok(text(out).length < 20_000);
            const data = page(out);
            for (const message of data.messages) reconstructed += message.text;
            if (data.nextOffset === null) break;
            assert.ok(data.nextOffset > offset);
            offset = data.nextOffset;
        }
        assert.equal(reconstructed, original);
    });

    it("finds an exact target on a later bounded metadata page", async () => {
        const { ctx, calls } = readContext([historyEntry("one", "user", "hi")]);
        const call = ctx.call;
        assert.ok(call);
        let listCalls = 0;
        ctx.call = async (method, workspace, params) => {
            if (method === "session.list" && listCalls++ === 0) {
                return {
                    workspace,
                    sessions: [],
                    total: 1,
                    nextCursor: {
                        updatedAt: new Date(T0).toISOString(),
                        id: asSessionId("cursor"),
                    },
                } as never;
            }
            return call(method, workspace, params);
        };
        const out = page(await invokeTool(await readTool(), { sessionId: "target" }, ctx));
        assert.equal(out.messages[0].text, "hi");
        assert.equal(calls[0]?.params.cursor !== undefined, true);
        assert.equal(calls[0]?.params.full, undefined);
    });

    it("rejects a repeating metadata cursor without an infinite loop", async () => {
        const { ctx } = readContext([]);
        let calls = 0;
        ctx.call = async (_method, workspace) => {
            calls++;
            return {
                workspace,
                sessions: [],
                total: 1,
                nextCursor: {
                    updatedAt: new Date(T0).toISOString(),
                    id: asSessionId("cursor"),
                },
            } as never;
        };
        await assert.rejects(
            invokeTool(await readTool(), { sessionId: "target" }, ctx),
            /pagination did not advance/,
        );
        assert.equal(calls, 2);
    });

    it("reports a missing RPC dispatcher clearly", async () => {
        const { ctx } = readContext([]);
        await assert.rejects(
            invokeTool(await readTool(), { sessionId: "target" }, { ...ctx, call: undefined }),
            /no self-RPC dispatcher/,
        );
    });

    it("returns a completed empty page past the end", async () => {
        const { ctx } = readContext([historyEntry("one", "user", "hello")]);
        const out = page(
            await invokeTool(await readTool(), { sessionId: "target", offset: 999 }, ctx),
        );
        assert.deepEqual(out.messages, []);
        assert.equal(out.nextOffset, null);
    });
    for (const params of [
        { offset: -1 },
        { offset: 0.5 },
        { limit: 0 },
        { limit: 1000 },
        { sessionId: "" },
    ]) {
        it(`rejects invalid input ${JSON.stringify(params)} before RPC`, async () => {
            const { ctx, calls } = readContext([]);
            await assert.rejects(
                invokeTool(await readTool(), { sessionId: "target", ...params }, ctx),
                /sessionId|offset|limit/,
            );
            assert.deepEqual(calls, []);
        });
    }
});
