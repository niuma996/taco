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
    it("offers both tools as deferred builtins", () => {
        const c = sessionHistoryToolCandidates();
        assert.deepEqual(
            c.map((x) => [x.name, x.loading, x.source]),
            [
                ["sessionSearch", "deferred", "builtin"],
                ["sessionList", "deferred", "builtin"],
            ],
        );
        assert.match(c[1]?.summary ?? "", /Last resort/);
    });
});
