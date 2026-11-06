/** Bounded recall of a visible same-workspace conversation via session.history. */

import type { SessionHistoryEntry, SessionListEntry } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/protocol";
import { type Static, Type } from "typebox";
import { applyTuiVisibilityToContent } from "../tags/index.ts";
import type { TacoToolContext } from "./context.ts";
import type { TacoTool } from "./index.ts";

const MAX_SEGMENTS = 10;
const SEGMENT_CHARS = 2_000;
const PAGE_CHARS = 20_000;
const METADATA_PAGE_SIZE = 50;

const readSchema = Type.Object({
    sessionId: Type.String({
        minLength: 1,
        maxLength: 200,
        description:
            "Exact source session ID from memory provenance, sessionSearch, or sessionList.",
    }),
    offset: Type.Optional(
        Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            description:
                "Text segments to skip (default 0). Use the previous nextOffset unchanged.",
        }),
    ),
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: MAX_SEGMENTS,
            description: `Maximum text segments per page (default ${MAX_SEGMENTS}). Huge messages span multiple segments.`,
        }),
    ),
});

type SessionReadInput = Static<typeof readSchema>;
interface TranscriptSegment {
    entryId: string;
    role: "user" | "assistant";
    timestamp: string;
    /** UTF-16 position in the visible text of this message. */
    textOffset: number;
    text: string;
    continued: boolean;
}

function boundedMetadata(text: string, limit: number): string {
    return text.slice(0, limit);
}

/** Only plain text enters recall; tool arguments/results, thinking and attachments stay out. */
function* transcriptSegments(
    entries: readonly SessionHistoryEntry[],
): Generator<TranscriptSegment> {
    for (const entry of entries) {
        if (entry.type !== "message" || !entry.payload || typeof entry.payload !== "object")
            continue;
        const message = entry.payload as { role?: unknown; content?: unknown };
        if (message.role !== "user" && message.role !== "assistant") continue;
        const raw =
            typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                  ? message.content
                        .flatMap((block: unknown) => {
                            if (!block || typeof block !== "object") return [];
                            const b = block as { type?: unknown; text?: unknown };
                            return b.type === "text" && typeof b.text === "string" ? [b.text] : [];
                        })
                        .join("\n")
                  : "";
        const text = applyTuiVisibilityToContent(raw) as string;
        if (!text.trim()) continue;
        for (let start = 0; start < text.length; ) {
            let end = Math.min(start + SEGMENT_CHARS, text.length);
            // Do not turn a supplementary character into broken surrogates across pages.
            if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
            yield {
                entryId: boundedMetadata(entry.id, 160),
                role: message.role,
                timestamp: boundedMetadata(entry.timestamp, 40),
                textOffset: start,
                text: text.slice(start, end),
                continued: end < text.length,
            };
            start = end;
        }
    }
}

async function visibleTarget(ctx: TacoToolContext, sessionId: string): Promise<SessionListEntry> {
    if (!ctx.call) throw new Error("sessionRead: no self-RPC dispatcher in this workspace");
    // Query before pagination: metadata never requires a full-store response.
    let cursor: { updatedAt: string; id: SessionListEntry["id"] } | undefined;
    const seen = new Set<string>();
    do {
        const result = await ctx.call(RPC.sessionList, ctx.workspace, {
            workspace: ctx.workspace,
            query: sessionId,
            limit: METADATA_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
        });
        const target = result.sessions.find(
            (s) =>
                s.id === sessionId &&
                s.cwd === ctx.workspace &&
                s.kind !== "subagent" &&
                !s.parentSessionId,
        );
        if (target) return target;
        cursor = result.nextCursor;
        if (cursor) {
            const key = JSON.stringify(cursor);
            if (seen.has(key))
                throw new Error("sessionRead: session list pagination did not advance");
            seen.add(key);
        }
    } while (cursor);
    throw new Error(
        "sessionRead: session not found or unavailable in this workspace (it may have been deleted).",
    );
}

export function createSessionReadTool(): TacoTool {
    return {
        name: "sessionRead",
        label: "sessionRead",
        description:
            "Recall the original conversation for a memory source or a sessionSearch/sessionList result. " +
            "Requires an exact visible session ID in this workspace. Returns only normal user and assistant text " +
            "on the current conversation branch, excluding thinking and tool content. " +
            "offset counts bounded text segments, not messages; huge messages span segments. " +
            "Pass nextOffset unchanged to continue; null means finished. Read only the pages needed to answer.",
        parameters: readSchema,
        executionMode: "sequential",
        taco: {
            mutates: false,
            promptSummary:
                "Read a memory source session's original user/assistant conversation in bounded pages.",
        },
        async execute(
            _toolCallId: string,
            params: SessionReadInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ) {
            if (ctx.sessionKind !== "main" || ctx.isIm) {
                throw new Error(
                    "Past sessions are not available here. Only the user's own local main session may read their conversation history.",
                );
            }
            if (
                typeof params.sessionId !== "string" ||
                !params.sessionId.trim() ||
                params.sessionId.length > 200
            ) {
                throw new Error(
                    "sessionId must be an exact non-empty session ID (at most 200 characters)",
                );
            }
            const offset = params.offset ?? 0;
            const limit = params.limit ?? MAX_SEGMENTS;
            if (!Number.isSafeInteger(offset) || offset < 0)
                throw new Error("offset must be a non-negative safe integer");
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEGMENTS)
                throw new Error(`limit must be an integer from 1 to ${MAX_SEGMENTS}`);
            const target = await visibleTarget(ctx, params.sessionId);
            if (!ctx.call) throw new Error("sessionRead: no self-RPC dispatcher in this workspace");
            const history = await ctx
                .call(RPC.sessionHistory, ctx.workspace, {
                    workspace: ctx.workspace,
                    sessionId: target.id,
                })
                .catch(() => {
                    // Files can disappear after authorization. Internal RPC errors may contain paths or payloads.
                    throw new Error(
                        "sessionRead: conversation unavailable; the session may have been deleted or cannot be read.",
                    );
                });
            const messages: TranscriptSegment[] = [];
            const page = {
                sessionId: target.id,
                title: boundedMetadata(target.name ?? "", 200),
                offset,
                messages,
                nextOffset: null as number | null,
            };
            let index = 0;
            let remainingChars = PAGE_CHARS - JSON.stringify(page).length - 32;
            for (const segment of transcriptSegments(history.entries)) {
                if (index++ < offset) continue;
                const size = JSON.stringify(segment).length + 1;
                if (messages.length >= limit || size > remainingChars) {
                    page.nextOffset = offset + messages.length;
                    break;
                }
                messages.push(segment);
                remainingChars -= size;
            }
            return {
                content: [{ type: "text" as const, text: JSON.stringify(page) }],
                details: page,
            };
        },
    };
}
