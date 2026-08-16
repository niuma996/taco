/**
 * Memory extraction — fires at the end of each turn.
 *
 * Gate: token estimate < MIN_TOKENS → skip
 * Truncate: last ~8000 chars
 * LLM call: completeSimple (lite model, temp 0.1, maxTokens 300)
 * Output: JSON → MemoryEntry[] → store.appendEntry()
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { extractJsonSpan } from "../../lib/jsonExtract.ts";
import { createLogger } from "../../lib/logger.ts";
import { tacoRequestHeaders } from "../../runtime/runtimeResources.ts";
import { serializeMessagesForFacts } from "../../tags/factExtractor.ts";
import {
    MEMORY_ENTRY_TYPES,
    type MemoryEntry,
    type MemoryEntryType,
    type MemoryExtractor,
} from "../types.ts";

const log = createLogger("memory:extractor");

// ─── constants ────────────────────────────────────────────────────────────────

const MIN_TOKEN_THRESHOLD = 50;
const MAX_CHARS = 8000;
const MAX_TOKENS = 300;
const LLM_TEMPERATURE = 0.1;

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Given a conversation transcript, extract any facts worth remembering for future sessions.

Output a JSON array of memory entries. Each entry must have these fields:
- id: a short unique id string (e.g. "user_role", "feedback_auth", "project_init")
- name: a concise human-readable name (max 60 chars)
- description: a one-line description used to decide relevance (max 120 chars)
- type: one of "user" | "feedback" | "project" | "reference"
- content: the fact itself, in 1-3 sentences (hard cap ${MEMORY_CONTENT_MAX_CHARS} chars, but stay far below it)

Type guidelines:
- "user": user roles, preferences, knowledge background, technical stack
- "feedback": user corrections or confirmations of AI behavior (include why)
- "project": project state, goals, constraints, deadlines
- "reference": pointers to external systems (URLs, file paths, tools)

Rules:
- Extract only high-value, non-obvious information
- One entry holds ONE fact. If a fact needs bullet lists or headings to express, it is several facts — emit several entries instead
- Never emit code snippets, directory layouts, or architecture overviews; those are derivable from the repo
- Skip obvious facts, redundant info, and tool results
- Do not fabricate; extract only what is explicitly present
- Never extract transient session state: current working directory, workspace/scratch paths, IM channel names, or file paths that are only meaningful inside one conversation
- Output ONLY the JSON array, no markdown fences, no explanation`;

const EXTRACTION_USER_PROMPT = `Extract memory-worthy information from this conversation:

{conversation}

Return a JSON array of memory entries:`;

// ─── extraction prompt builder ────────────────────────────────────────────────

function buildExtractionPrompt(conversation: string): { system: string; user: string } {
    return {
        system: EXTRACTION_SYSTEM_PROMPT,
        user: EXTRACTION_USER_PROMPT.replace("{conversation}", conversation),
    };
}

// ─── JSON parsing ────────────────────────────────────────────────────────────

interface RawMemoryEntry {
    id?: string;
    name?: string;
    description?: string;
    type?: string;
    content?: string;
}

/**
 * Parse the LLM's JSON array output into `MemoryEntry[]`.
 *
 * Exported so it can be unit-tested without spinning up the LLM extraction
 * path. Returns [] on any failure.
 *
 * Drop policy: missing `name`/`type`, or `type` not in MEMORY_ENTRY_TYPES
 * (would be unreadable on disk since parseTopicFrontmatter rejects it).
 */
export function parseExtractionResult(
    raw: string,
    createdAt: string,
    workspaceId?: string,
): MemoryEntry[] {
    // Strip markdown fences first; the broader `extractJsonArray` handles
    // prose but fences are the common case.
    const trimmed = raw.trim();
    const json = trimmed
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

    const parsed = extractJsonSpan(json, "[]");
    if (!Array.isArray(parsed)) return [];

    return (parsed as RawMemoryEntry[])
        .map((item, i): MemoryEntry | null => {
            // Required fields: name + type. Other fields have sensible defaults.
            if (!item || typeof item.name !== "string" || typeof item.type !== "string") {
                return null;
            }
            // Validate type — invalid types would be unreadable on disk
            // (parseTopicFrontmatter rejects anything not in MEMORY_ENTRY_TYPES).
            const typeRaw = item.type;
            if (!(MEMORY_ENTRY_TYPES as readonly string[]).includes(typeRaw)) {
                return null;
            }
            const id = item.id
                ? String(item.id)
                      .toLowerCase()
                      .replace(/\s+/g, "_")
                      .replace(/[^a-z0-9_]/g, "")
                : `mem-${Date.now()}-${i}`;
            return {
                id: id.slice(0, 64),
                name: String(item.name).slice(0, 60),
                description: String(item.description ?? item.name).slice(0, 120),
                type: typeRaw as MemoryEntryType,
                content: String(item.content ?? item.description ?? item.name).slice(
                    0,
                    MEMORY_CONTENT_MAX_CHARS,
                ),
                createdAt,
                workspaceId,
            };
        })
        .filter((e): e is MemoryEntry => e !== null);
}

/**
 * Compute the messages to feed the extractor from a full conversation and an
 * optional offset captured at the last successful remember tool call.
 *
 * Pure: no I/O, no async, no side effects. Exported for unit tests.
 *
 * Semantics: undefined → send everything; >= length → send []; < 0 → 0
 * (defensive); otherwise → `messages.slice(sinceCount)`.
 */
export function sliceForExtraction(
    messages: readonly AgentMessage[],
    sinceCount: number | undefined,
): AgentMessage[] {
    if (sinceCount === undefined) return messages.slice();
    const start = Math.max(0, sinceCount);
    if (start >= messages.length) return [];
    return messages.slice(start);
}

// ─── token heuristic ──────────────────────────────────────────────────────────

/** Rough token estimate: char count / 4 (Unicode-aware). */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── MemoryExtractor ──────────────────────────────────────────────────────────

export class MemoryExtractorImpl implements MemoryExtractor {
    constructor(
        private readonly models: Models,
        private readonly model: Model<Api>,
        private readonly store: {
            appendEntry(entry: MemoryEntry): Promise<void>;
        },
        private readonly workspaceId: string,
    ) {}

    async onTurnEnd(messages: readonly AgentMessage[]): Promise<void> {
        try {
            await this.extract(messages);
        } catch (err) {
            // Fire-and-forget: never fail the turn
            log.error("extraction failed:", err);
        }
    }

    private async extract(messages: readonly AgentMessage[]): Promise<void> {
        // Format conversation
        const serialized = serializeMessagesForFacts(messages);
        if (serialized.trim().length === 0) return;

        // Token gate
        if (estimateTokens(serialized) < MIN_TOKEN_THRESHOLD) return;

        // Truncate to last ~8000 chars
        const truncated = serialized.length > MAX_CHARS ? serialized.slice(-MAX_CHARS) : serialized;

        // LLM call — bypasses the harness streamOptions (which carries the
        // `withTacoUserAgent` tag for main turns), so we attach the same
        // taco identification here. Without it, this call shows up at the
        // provider as the OpenAI SDK default `Nr/JS <ver>` (the bundled
        // sidecar mangles the class name).
        const { system, user } = buildExtractionPrompt(truncated);
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

        if (!rawText) return;

        const createdAt = new Date().toISOString();
        const entries = parseExtractionResult(rawText, createdAt, this.workspaceId);

        for (const entry of entries) {
            await this.store.appendEntry(entry);
        }
    }
}
