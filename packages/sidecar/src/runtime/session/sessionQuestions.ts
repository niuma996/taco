/**
 * User-question reader — the messages a person actually typed into a session,
 * read straight from its pi JSONL file.
 *
 * "Actually typed" is decided by the same TUI visibility policy the desktop
 * renders with: synthetic user-role messages (askUser answers, background
 * subagent notices) are wrapped in hidden tags, so stripping hidden tags and
 * dropping what is left empty excludes them. Per-request context tags (git,
 * env, memory) are appended to the outbound request only and never persisted,
 * so there is nothing else to strip.
 *
 * pi storage is append-only: entries a compaction summarized away, and those
 * on abandoned branches, are still in the file and are still returned — the
 * user did ask them.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as readline from "node:readline";
import { applyTuiVisibilityToContent } from "../../tags/index.ts";
import type { ImageContent, TextContent } from "../pi/types.ts";
import { messageTimestamp } from "./sessionMetadataReader.ts";

export interface UserQuestion {
    /** Epoch milliseconds. */
    readonly at: number;
    readonly text: string;
}

/**
 * The visible user text of one parsed JSONL record, or undefined when the
 * record is not a user message or nothing user-typed remains.
 *
 * v4 entries: `{kind:"entry", type:"message", timestamp, message:{role, content}}`.
 * v3 records: `{type:"message", timestamp:"<ISO>", message:{role, content}}`.
 */
export function userQuestionFromRecord(record: unknown): UserQuestion | undefined {
    if (record === null || typeof record !== "object") return undefined;
    const rec = record as { type?: unknown; timestamp?: unknown; message?: unknown };
    const at = messageTimestamp(rec);
    if (at === undefined) return undefined;
    const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
    if (msg?.role !== "user") return undefined;
    const content = msg.content;
    if (typeof content !== "string" && !Array.isArray(content)) return undefined;
    const visible = applyTuiVisibilityToContent(content as string | (TextContent | ImageContent)[]);
    const text = (
        typeof visible === "string"
            ? visible
            : visible
                  .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
                  .map((b) => b.text)
                  .join("\n")
    ).trim();
    return text.length > 0 ? { at, text } : undefined;
}

/** Every user question in one session file, oldest first. */
export async function readUserQuestionsFromDisk(path: string): Promise<UserQuestion[]> {
    // Same fd caveat as readSessionMetadataFromDisk: readline does not close
    // its input, so the stream is destroyed explicitly.
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    const questions: UserQuestion[] = [];
    try {
        for await (const line of rl) {
            // Cheap pre-filter: only message lines can hold a question.
            if (!line.includes('"type":"message"') || !line.includes('"role":"user"')) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue; // torn last line after a crash mid-append
            }
            // pi commits multi-write batches as a JSON array on one line.
            for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
                const q = userQuestionFromRecord(record);
                if (q) questions.push(q);
            }
        }
    } finally {
        rl.close();
        if (!stream.destroyed) stream.destroy();
    }
    return questions.sort((a, b) => a.at - b.at);
}

/**
 * Per-file cache keyed by (mtime, size). Kept apart from SessionRegistry's
 * list caches on purpose: those are dropped after every prompt, and a full
 * re-read of every transcript per search is exactly what this avoids.
 */
export class UserQuestionCache {
    private readonly entries = new Map<
        string,
        { mtimeMs: number; size: number; questions: UserQuestion[] }
    >();

    async read(path: string): Promise<UserQuestion[]> {
        const st = await stat(path);
        const hit = this.entries.get(path);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.questions;
        const questions = await readUserQuestionsFromDisk(path);
        this.entries.set(path, { mtimeMs: st.mtimeMs, size: st.size, questions });
        return questions;
    }

    /** Drop entries for files no longer listed, so deleted sessions do not pin memory. */
    retainOnly(paths: ReadonlySet<string>): void {
        for (const key of this.entries.keys()) {
            if (!paths.has(key)) this.entries.delete(key);
        }
    }
}
