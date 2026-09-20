/**
 * Title summarization — re-derives a session's title on every successful
 * `run_end`, so a long conversation's title follows where it actually went.
 *
 * Gate: only "completed" runs. Overwriting is bounded downstream, not here —
 * `setSummaryTitle` refuses to overwrite a user rename, and `writeTitle`
 * skips the append when the derived title is unchanged (see
 * sessionRegistry.ts / sessionTitleSource.ts).
 * Truncate: last ~4000 chars of the branch context, serialized the same way
 * memory extraction serializes a conversation. Tail rather than head is what
 * makes re-derivation worth doing — the newest turns are the ones the old
 * title does not describe.
 * LLM call: completeSimple (session's own model, temp 0.2, maxTokens 30).
 * Output: plain text → trimmed → clamped to MAX_TITLE_LENGTH graphemes → setSummaryTitle.
 *
 * Modeled directly on MemoryExtractorImpl (../../memory/local/extractor.ts):
 * same completeSimple call shape, same tacoRequestHeaders() tagging, same
 * fire-and-forget error handling. Not merged into that class — memory
 * extraction is keyed to `turn_end` and writes topic files; titling is keyed
 * to `run_end` and writes one session value, so the two would share only the
 * LLM plumbing and none of the trigger or write logic.
 */

import type { SessionId } from "@taco-ai/protocol";
import { createLogger } from "../../lib/logger.ts";
import { serializeMessagesForFacts } from "../../tags/factExtractor.ts";
import type { AgentMessage, Api, Model, Models, TextContent } from "../pi/types.ts";
import { tacoRequestHeaders } from "../runtimeResources.ts";

const log = createLogger("session:titleSummarizer");

// ─── constants ────────────────────────────────────────────────────────────────

/** Below this, a conversation is too thin to summarize meaningfully — the
 *  placeholder title (first message, truncated) is already just as good. */
const MIN_TOKEN_THRESHOLD = 30;
/** Matches the memory extractor's truncation window; a title needs far less
 *  context than fact extraction, but the same tail-of-conversation heuristic
 *  (most recent content is most representative) applies. */
const MAX_CHARS = 4000;
const MAX_TOKENS = 30;
const LLM_TEMPERATURE = 0.2;
/** Hard cap enforced server-side — the model is asked to stay under this, but
 *  the prompt is a request, not a contract. */
const MAX_TITLE_LENGTH = 20;

const TITLE_SYSTEM_PROMPT = `You write short titles for chat session sidebars.

Given a conversation, output ONE short title summarizing what the conversation is about.

Rules:
- Output ONLY the title text — no quotes, no markdown, no trailing punctuation, no explanation
- Maximum ${MAX_TITLE_LENGTH} characters (or ${MAX_TITLE_LENGTH} CJK characters if the conversation is in Chinese)
- Match the conversation's own language
- Describe the topic or task, not the fact that it's a conversation ("Fix login redirect bug", not "Discussion about a bug")`;

const TITLE_USER_PROMPT = `Summarize this conversation into a title:

{conversation}

Title:`;

function buildTitlePrompt(conversation: string): { system: string; user: string } {
    return {
        system: TITLE_SYSTEM_PROMPT,
        user: TITLE_USER_PROMPT.replace("{conversation}", conversation),
    };
}

// ─── output cleanup ───────────────────────────────────────────────────────────

/**
 * Clean up the model's raw title output: strip surrounding quotes/markdown
 * emphasis the model sometimes adds despite instructions, trim, and clamp to
 * `MAX_TITLE_LENGTH` grapheme clusters (not UTF-16 code units — a surrogate-pair
 * emoji or a combining-mark CJK character must not be split in half).
 *
 * Exported so the clamp/strip logic is unit-testable without an LLM call.
 */
export function cleanTitle(raw: string): string {
    const stripped = raw
        .trim()
        .replace(/^["'“”「『*_#\s]+/, "")
        .replace(/["'“”」』*_\s.。!！]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    const graphemes = Array.from(stripped);
    return graphemes.length > MAX_TITLE_LENGTH
        ? graphemes.slice(0, MAX_TITLE_LENGTH).join("")
        : stripped;
}

// ─── token heuristic ──────────────────────────────────────────────────────────

/** Rough token estimate: char count / 4 (Unicode-aware). Mirrors the memory extractor. */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── TitleSummarizer ──────────────────────────────────────────────────────────

export class TitleSummarizer {
    constructor(
        private readonly models: Models,
        private readonly model: Model<Api>,
        private readonly sessionId: SessionId,
        private readonly setSummaryTitle: (sessionId: SessionId, name: string) => Promise<boolean>,
    ) {}

    /**
     * Fire-and-forget: called from every "completed" `run_end`. Never throws —
     * a summarization failure must not surface anywhere the caller would treat
     * as a run failure.
     */
    async onRunEnd(messages: readonly AgentMessage[]): Promise<void> {
        try {
            await this.summarize(messages);
        } catch (err) {
            log.error("title summarization failed:", err);
        }
    }

    private async summarize(messages: readonly AgentMessage[]): Promise<void> {
        const serialized = serializeMessagesForFacts(messages);
        if (serialized.trim().length === 0) return;

        if (estimateTokens(serialized) < MIN_TOKEN_THRESHOLD) return;

        const truncated = serialized.length > MAX_CHARS ? serialized.slice(-MAX_CHARS) : serialized;

        // Bypasses the harness streamOptions (which carries the
        // `withTacoUserAgent` tag for main turns), so we attach the same taco
        // identification here — see MemoryExtractorImpl for the identical
        // rationale.
        const { system, user } = buildTitlePrompt(truncated);
        const res = await this.models.completeSimple(
            this.model,
            {
                systemPrompt: system,
                messages: [{ role: "user", content: user, timestamp: Date.now() }],
            },
            { maxTokens: MAX_TOKENS, temperature: LLM_TEMPERATURE, headers: tacoRequestHeaders() },
        );

        if (!res) return;
        const rawText = res.content
            .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
        if (!rawText.trim()) return;

        const title = cleanTitle(rawText);
        if (!title) return;

        await this.setSummaryTitle(this.sessionId, title);
    }
}
