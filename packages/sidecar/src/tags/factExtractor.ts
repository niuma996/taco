/**
 * Structured fact extraction for compaction. pi's default compaction emits a markdown
 * summary but no queryable store; we add an LLM call that extracts decisions,
 * constraints, and entities into JSON. Output rides as `details.facts`. Subsequent
 * compactions merge via `mergeFacts` (monotonic, no duplicates). Failure: caller
 * receives `EMPTY_FACTS`; compression never blocks.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { extractJsonSpan } from "../lib/jsonExtract.ts";

// ─── types ───────────────────────────────────────────────────────────────────

export interface FactItem {
    /** Stable identifier / descriptor. Key for dedup. */
    readonly text: string;
    /** One-sentence citation from the conversation. */
    readonly evidence: string;
}

export interface EntityItem {
    readonly name: string;
    readonly type: string;
    readonly note: string;
}

export interface FactSet {
    readonly decisions: readonly FactItem[];
    readonly constraints: readonly FactItem[];
    readonly entities: readonly EntityItem[];
}

export const EMPTY_FACTS: FactSet = Object.freeze({
    decisions: [],
    constraints: [],
    entities: [],
});

// ─── JSON schema description for the prompt ──────────────────────────────────

const FACT_SCHEMA_DESCRIPTION = `Return ONLY valid JSON matching this exact shape (no prose, no markdown fences):
{
  "decisions":   [ { "text": string, "evidence": string }, ... ],
  "constraints": [ { "text": string, "evidence": string }, ... ],
  "entities":    [ { "name": string, "type": string, "note": string }, ... ]
}

Rules:
- Only include facts the user or model explicitly committed to (decisions),
  hard rules the user demanded must hold (constraints), or named objects /
  preferences the user mentioned (entities). Omit a category if empty
  (return an empty array).
- Keep each "text" / "name" short (≤ 80 chars). Use "evidence" to cite the
  line or turn the fact was established on.
- Output language follows the conversation's primary language.`;

// ─── prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
    "You extract structured facts from a conversation. Output only JSON — no commentary.";

function buildUserPrompt(serializedConversation: string): string {
    return `${FACT_SCHEMA_DESCRIPTION}\n\n# Conversation\n\n${serializedConversation}\n`;
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

/** Coerce LLM output into a well-typed FactSet, dropping malformed entries. */
function coerceFacts(raw: unknown): FactSet {
    if (!raw || typeof raw !== "object") return EMPTY_FACTS;
    const o = raw as Record<string, unknown>;
    const pickFact = (v: unknown): FactItem[] => {
        if (!Array.isArray(v)) return [];
        const out: FactItem[] = [];
        for (const item of v) {
            if (!item || typeof item !== "object") continue;
            const f = item as Record<string, unknown>;
            if (typeof f.text === "string" && typeof f.evidence === "string") {
                out.push({ text: f.text, evidence: f.evidence });
            }
        }
        return out;
    };
    const pickEntities = (v: unknown): EntityItem[] => {
        if (!Array.isArray(v)) return [];
        const out: EntityItem[] = [];
        for (const item of v) {
            if (!item || typeof item !== "object") continue;
            const e = item as Record<string, unknown>;
            if (
                typeof e.name === "string" &&
                typeof e.type === "string" &&
                typeof e.note === "string"
            ) {
                out.push({ name: e.name, type: e.type, note: e.note });
            }
        }
        return out;
    };
    return {
        decisions: pickFact(o.decisions),
        constraints: pickFact(o.constraints),
        entities: pickEntities(o.entities),
    };
}

// ─── serialization ───────────────────────────────────────────────────────────

/**
 * Format messages into plain text for the extraction prompt. We don't reuse
 * pi's internal `serializeConversation` because it's a single-export taking
 * only `Message[]` from pi-ai; we accept `AgentMessage[]` and degrade
 * gracefully. Cost: at most `messagesToSummarize` per compaction call.
 */
export function serializeMessagesForFacts(messages: ReadonlyArray<AgentMessage>): string {
    const lines: string[] = [];
    for (const m of messages) {
        const role = (m as { role?: unknown }).role;
        const content = (m as { content?: unknown }).content;
        let body: string;
        if (typeof content === "string") {
            body = content;
        } else if (Array.isArray(content)) {
            body = content
                .map((b) => {
                    if (!b || typeof b !== "object") return "";
                    const bb = b as Record<string, unknown>;
                    if (bb.type === "text" && typeof bb.text === "string") return bb.text;
                    if (bb.type === "toolCall") return `[tool_call: ${String(bb.toolName)}]`;
                    return "";
                })
                .filter(Boolean)
                .join("\n");
        } else {
            body = "";
        }
        lines.push(`[${typeof role === "string" ? role : "unknown"}]\n${body}\n`);
    }
    return lines.join("\n");
}

// ─── extraction call ─────────────────────────────────────────────────────────

// pi-agent-core's `completeSimple()` is typed `Model<any>` because provider
// APIs are heterogeneous. Re-exposing `Model<any>` here mirrors that public
// surface so callers can pass through the harness model unchanged.
// biome-ignore lint/suspicious/noExplicitAny: see comment above.
type AnyProviderModel = Model<any>;

export interface ExtractFactsOptions {
    readonly signal?: AbortSignal;
    /** Override the model used for fact extraction (defaults to the harness model).
     *  Optional so callers can route to a cheaper model later. */
    readonly model?: AnyProviderModel;
}

/**
 * Run one LLM call against `messages` to extract structured facts.
 * Returns `EMPTY_FACTS` on any failure — never throws to the caller.
 */
export async function extractFacts(
    messages: ReadonlyArray<AgentMessage>,
    models: Models,
    model: AnyProviderModel,
    options: ExtractFactsOptions = {},
): Promise<FactSet> {
    try {
        const serialized = serializeMessagesForFacts(messages);
        if (serialized.trim().length === 0) return EMPTY_FACTS;
        const m = options.model ?? model;
        const res = await models.completeSimple(
            m,
            {
                systemPrompt: SYSTEM_PROMPT,
                messages: [
                    { role: "user", content: buildUserPrompt(serialized), timestamp: Date.now() },
                ],
            },
            { maxTokens: 800, signal: options.signal },
        );
        if (!res || typeof res !== "object") return EMPTY_FACTS;
        const text = (res as { content?: unknown }).content;
        const str =
            typeof text === "string"
                ? text
                : Array.isArray(text)
                  ? text
                        .map((b) =>
                            b &&
                            typeof b === "object" &&
                            (b as { type?: unknown }).type === "text" &&
                            typeof (b as { text?: unknown }).text === "string"
                                ? (b as { text: string }).text
                                : "",
                        )
                        .join("")
                  : "";
        const parsed = extractJsonSpan(str, "{}");
        return coerceFacts(parsed);
    } catch {
        return EMPTY_FACTS;
    }
}

// ─── merge across compactions ────────────────────────────────────────────────

function dedupFacts(items: readonly FactItem[], keyFn: (f: FactItem) => string): FactItem[] {
    const byKey = new Map<string, FactItem>();
    for (const f of items) {
        // Later occurrences override earlier — `mergeFacts` is called with
        // `existing` first, so later passes naturally win.
        byKey.set(keyFn(f), f);
    }
    return [...byKey.values()];
}

function dedupEntities(items: readonly EntityItem[]): EntityItem[] {
    const byKey = new Map<string, EntityItem>();
    for (const e of items) {
        byKey.set(`${e.name}|${e.type}`, e);
    }
    return [...byKey.values()];
}

/**
 * Merge `fresh` facts on top of `existing`, deduping by stable keys.
 * Later occurrences of the same key win (caller passes existing → fresh).
 */
export function mergeFacts(existing: FactSet, fresh: FactSet): FactSet {
    return {
        decisions: dedupFacts([...existing.decisions, ...fresh.decisions], (f) => f.text),
        constraints: dedupFacts([...existing.constraints, ...fresh.constraints], (f) => f.text),
        entities: dedupEntities([...existing.entities, ...fresh.entities]),
    };
}
