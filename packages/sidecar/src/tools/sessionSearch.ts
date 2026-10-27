/**
 * sessionSearch / sessionList — let the model answer questions about the
 * user's past conversations in this workspace ("have I asked about X lately?").
 *
 * Both are deferred candidates: cross-session recall is rare, and their
 * schemas would otherwise cost tokens on every request. `sessionSearch` is the
 * intended entry point; `sessionList` exists for the few questions that cannot
 * be phrased as keywords, and its wording steers the model away from paging
 * through history by default — every page is the user's private text landing
 * in context.
 *
 * Sessions come from `session.list` over self-RPC, which already hides
 * subagent transcripts. The current session is excluded: it contains the very
 * question being asked, so it would always match.
 */

import type { SessionListEntry } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolCandidate } from "../runtime/harness/deferredToolRegistry.ts";
import { type UserQuestion, UserQuestionCache } from "../runtime/session/sessionQuestions.ts";
import type { TacoToolContext } from "./context.ts";
import type { TacoTool } from "./index.ts";

const SEARCH_DEFAULT_RESULTS = 20;
const SEARCH_MAX_RESULTS = 50;
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
const SNIPPET_CHARS = 160;
const EXCERPT_CHARS = 80;
/** Files read concurrently; bounded so a large store does not exhaust fds. */
const READ_CONCURRENCY = 8;

const sinceSchema = Type.Optional(
    Type.String({
        description:
            "Only consider questions asked at or after this ISO date/time (e.g. 2026-10-01).",
    }),
);
const untilSchema = Type.Optional(
    Type.String({ description: "Only consider questions asked before this ISO date/time." }),
);

const searchSchema = Type.Object({
    keywords: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 20,
        description:
            "Case-insensitive substrings; a question matches if it contains ANY of them. " +
            "Include synonyms, translations (Chinese and English), abbreviations and common " +
            "misspellings — a term the user phrased differently will not match.",
    }),
    since: sinceSchema,
    until: untilSchema,
    maxResults: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: SEARCH_MAX_RESULTS,
            description: `Matching questions to show (default ${SEARCH_DEFAULT_RESULTS}). Counts are always complete.`,
        }),
    ),
});

const listSchema = Type.Object({
    since: sinceSchema,
    until: untilSchema,
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: LIST_MAX_LIMIT,
            description: `Sessions per page (default ${LIST_DEFAULT_LIMIT}).`,
        }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Sessions to skip." })),
});

export type SessionSearchInput = Static<typeof searchSchema>;
export type SessionListInput = Static<typeof listSchema>;

const REFUSAL =
    "Past sessions are not available here. Only the user's own local main session may read " +
    "their conversation history.";

const SEARCH_DESCRIPTION =
    "Search the questions the user typed in their past sessions in this workspace. " +
    "Use it for questions about the user's own history: whether they asked about a topic, " +
    "when, and how often. Only user-typed messages are searched — not assistant replies, " +
    "tool output, or subagent sessions — and the current session is excluded. " +
    "The result reports how many sessions and questions were scanned and the hit count per " +
    "keyword. Zero hits means no question in that range contains those strings; before " +
    "telling the user they never asked, make sure the keyword list covered synonyms and " +
    "translations, and state the range that was searched.";

const LIST_DESCRIPTION =
    "Page through past sessions in this workspace (title, time, first question, transcript " +
    "path). Do NOT use this to answer whether the user asked about something — use " +
    "sessionSearch with keywords. Use it only when the user's request cannot be expressed as " +
    "keywords at all, or when the user explicitly asks to browse their sessions. Never page " +
    "through the whole history on your own initiative: ask for the smallest range that " +
    "answers the question, and stop as soon as you can answer.";

function allowed(ctx: TacoToolContext): boolean {
    return ctx.sessionKind === "main" && !ctx.isIm;
}

function parseBound(raw: string | undefined, field: string): number | undefined {
    if (raw === undefined) return undefined;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) throw new Error(`${field} is not a valid ISO date: ${raw}`);
    return at;
}

function inRange(at: number, since: number | undefined, until: number | undefined): boolean {
    return (since === undefined || at >= since) && (until === undefined || at < until);
}

function day(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}

function minute(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** A window of `SNIPPET_CHARS` around the first match, so long questions stay readable. */
export function snippetAround(text: string, index: number): string {
    const flat = oneLine(text);
    if (flat.length <= SNIPPET_CHARS) return flat;
    // `index` was found in the raw text; whitespace collapsing can shift it a
    // little, which only moves the window — the match still lands inside it.
    const start = Math.max(0, Math.min(index - SNIPPET_CHARS / 3, flat.length - SNIPPET_CHARS));
    const body = flat.slice(start, start + SNIPPET_CHARS);
    return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_CHARS < flat.length ? "…" : ""}`;
}

async function listOtherSessions(ctx: TacoToolContext): Promise<SessionListEntry[]> {
    if (!ctx.call) throw new Error("session.list: no self-RPC dispatcher in this workspace");
    const result = await ctx.call(RPC.sessionList, ctx.workspace, {
        workspace: ctx.workspace,
        full: true,
    });
    return result.sessions.filter((s) => s.id !== ctx.sessionId);
}

interface SessionQuestions {
    readonly session: SessionListEntry;
    readonly questions: readonly UserQuestion[];
}

async function readAll(
    cache: UserQuestionCache,
    sessions: readonly SessionListEntry[],
): Promise<{ read: SessionQuestions[]; unreadable: number }> {
    cache.retainOnly(new Set(sessions.map((s) => s.filePath)));
    const read: SessionQuestions[] = [];
    let unreadable = 0;
    for (let i = 0; i < sessions.length; i += READ_CONCURRENCY) {
        const batch = sessions.slice(i, i + READ_CONCURRENCY);
        const results = await Promise.all(
            batch.map((session) =>
                cache.read(session.filePath).then(
                    (questions) => ({ session, questions }),
                    () => undefined,
                ),
            ),
        );
        for (const r of results) {
            if (r) read.push(r);
            else unreadable++;
        }
    }
    return { read, unreadable };
}

function rangeText(since: string | undefined, until: string | undefined): string {
    if (since === undefined && until === undefined) return "all time";
    return `${since ?? "the beginning"} → ${until ?? "now"}`;
}

interface Hit {
    readonly session: SessionListEntry;
    readonly question: UserQuestion;
    readonly index: number;
}

export function createSessionSearchTool(cache: UserQuestionCache): TacoTool {
    return {
        name: "sessionSearch",
        label: "sessionSearch",
        description: SEARCH_DESCRIPTION,
        parameters: searchSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Search what the user asked in past sessions of this workspace by keywords. " +
                "The tool for 'have I asked about X' / 'when did I last ask about Y'.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: SessionSearchInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            if (!allowed(ctx)) throw new Error(REFUSAL);
            const since = parseBound(params.since, "since");
            const until = parseBound(params.until, "until");
            const keywords = [...new Set(params.keywords.map((k) => k.trim()).filter(Boolean))];
            if (keywords.length === 0) throw new Error("keywords must contain a non-empty term");
            const needles = keywords.map((k) => k.toLowerCase());
            const maxResults = params.maxResults ?? SEARCH_DEFAULT_RESULTS;

            const sessions = await listOtherSessions(ctx);
            const { read, unreadable } = await readAll(cache, sessions);

            const perKeyword = new Map(keywords.map((k) => [k, 0]));
            const hits: Hit[] = [];
            let scannedSessions = 0;
            let scannedQuestions = 0;
            let earliest: number | undefined;
            let latest: number | undefined;
            for (const { session, questions } of read) {
                let counted = false;
                for (const question of questions) {
                    if (!inRange(question.at, since, until)) continue;
                    if (!counted) {
                        scannedSessions++;
                        counted = true;
                    }
                    scannedQuestions++;
                    earliest =
                        earliest === undefined ? question.at : Math.min(earliest, question.at);
                    latest = latest === undefined ? question.at : Math.max(latest, question.at);
                    const lower = question.text.toLowerCase();
                    let first = -1;
                    for (let i = 0; i < needles.length; i++) {
                        const at = lower.indexOf(needles[i] as string);
                        if (at < 0) continue;
                        const kw = keywords[i] as string;
                        perKeyword.set(kw, (perKeyword.get(kw) ?? 0) + 1);
                        if (first < 0 || at < first) first = at;
                    }
                    if (first >= 0) hits.push({ session, question, index: first });
                }
            }
            hits.sort((a, b) => b.question.at - a.question.at);

            const lines: string[] = [];
            const span =
                earliest !== undefined && latest !== undefined
                    ? `questions dated ${day(earliest)} → ${day(latest)}`
                    : "no questions";
            lines.push(
                `Scanned ${scannedQuestions} questions in ${scannedSessions} past sessions of this ` +
                    `workspace (range: ${rangeText(params.since, params.until)}; ${span}). ` +
                    "The current session is excluded.",
            );
            if (unreadable > 0) {
                lines.push(`${unreadable} session file(s) could not be read and were skipped.`);
            }
            lines.push(
                `Hits per keyword: ${keywords.map((k) => `${k} (${perKeyword.get(k) ?? 0})`).join(", ")}`,
            );
            if (hits.length === 0) {
                lines.push(
                    "",
                    "No question in this range contains any of these keywords. This only rules " +
                        "out these exact strings — if a synonym, translation or abbreviation " +
                        "was not in the list, search again with it before concluding.",
                );
            } else {
                const sessionCount = new Set(hits.map((h) => h.session.id)).size;
                lines.push(
                    `${hits.length} matching questions in ${sessionCount} sessions, newest first:`,
                    "",
                );
                for (const h of hits.slice(0, maxResults)) {
                    const title = h.session.name ? ` "${h.session.name}"` : "";
                    lines.push(
                        `- ${minute(h.question.at)} · session ${h.session.id}${title}`,
                        `  ${snippetAround(h.question.text, h.index)}`,
                    );
                }
                if (hits.length > maxResults) {
                    lines.push(
                        `… (${hits.length - maxResults} more; narrow the range or keywords rather than raising maxResults)`,
                    );
                }
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                    scannedSessions,
                    scannedQuestions,
                    unreadable,
                    hitCount: hits.length,
                    perKeyword: Object.fromEntries(perKeyword),
                },
            };
        },
    };
}

export function createSessionListTool(cache: UserQuestionCache): TacoTool {
    return {
        name: "sessionList",
        label: "sessionList",
        description: LIST_DESCRIPTION,
        parameters: listSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Page through past sessions. Last resort — prefer sessionSearch; never browse " +
                "history unprompted.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: SessionListInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            if (!allowed(ctx)) throw new Error(REFUSAL);
            const since = parseBound(params.since, "since");
            const until = parseBound(params.until, "until");
            const limit = params.limit ?? LIST_DEFAULT_LIMIT;
            const offset = params.offset ?? 0;

            const sessions = (await listOtherSessions(ctx)).filter((s) =>
                inRange(Date.parse(s.updatedAt ?? s.createdAt), since, until),
            );
            const page = sessions.slice(offset, offset + limit);
            // Only the page is read: listing must not cost a full-store scan.
            const { read } = await readAll(cache, page);
            const firstQuestion = new Map(read.map((r) => [r.session.id, r.questions[0]?.text]));

            const lines = [
                `${sessions.length} past sessions in range (${rangeText(params.since, params.until)}), ` +
                    `showing ${page.length === 0 ? 0 : offset + 1}–${offset + page.length}, ` +
                    "most recently active first. The current session is excluded.",
            ];
            for (const s of page) {
                const first = firstQuestion.get(s.id);
                lines.push(
                    `- ${day(Date.parse(s.updatedAt ?? s.createdAt))} · ${s.id} · ${s.name ?? "(untitled)"}`,
                    `  first question: ${first ? clip(oneLine(first), EXCERPT_CHARS) : "(none)"}`,
                    `  transcript: ${s.filePath}`,
                );
            }
            if (offset + page.length < sessions.length) {
                lines.push(
                    "",
                    `${sessions.length - offset - page.length} more. Fetch another page only if ` +
                        "this one cannot answer the user's question.",
                );
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { total: sessions.length, offset, count: page.length },
            };
        },
    };
}

/**
 * Deferred candidates for the two tools. The question cache is shared by both
 * and lives as long as the workspace's registry.
 */
export function sessionHistoryToolCandidates(): ToolCandidate[] {
    const cache = new UserQuestionCache();
    return [
        {
            name: "sessionSearch",
            summary:
                "Search the questions the user asked in past sessions of this workspace by " +
                "keywords — 'have I asked about X', 'when did I last ask about Y'.",
            loading: "deferred",
            source: "builtin",
            load: async () => createSessionSearchTool(cache),
        },
        {
            name: "sessionList",
            summary:
                "Page through past sessions. Last resort: prefer sessionSearch, and never " +
                "browse history unless the user asks.",
            loading: "deferred",
            source: "builtin",
            load: async () => createSessionListTool(cache),
        },
    ];
}
