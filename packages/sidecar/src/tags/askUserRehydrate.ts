/**
 * askUser detail rehydration — parses `<ask_user_context>` injection text
 * in user messages and backfills it onto the matching askUser toolResult.
 *
 * Now we parse the injection and merge questions/answers into the matching
 * askUser toolResult's `details = { questions, answers, waiting: false,
 * answered: true }`. Parse failures leave the original message untouched.
 * Backfill skips if the toolResult already has non-empty answers.
 */

import type { AskUserQuestion } from "@taco-ai/protocol";

const OPEN_TAG = "<ask_user_context>";
const CLOSE_TAG = "</ask_user_context>";
const QUESTIONS_HEADER = "questions (JSON):";
const ANSWERS_HEADER = "answers (JSON):";

/** Parse the injection text — extract questions / answers JSON blocks. */
export interface ParsedAskUserContext {
    questions: AskUserQuestion[];
    answers: Record<string, string | string[]>;
}

function extractBalanced(text: string, open: string, close: string): string | null {
    const start = text.indexOf(open);
    if (start < 0) return null;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return null;
    return text.slice(start + open.length, end);
}

/**
 * Find the first JSON block (object or array) after `header` in `inner` and
 * return its raw text. Uses bracket-balanced scanning, not JSON.parse side-effects.
 */
function extractJsonBlock(inner: string, header: string): string | null {
    const headerIdx = inner.indexOf(header);
    if (headerIdx < 0) return null;
    const startScan = headerIdx + header.length;
    const firstOpen = inner.slice(startScan).search(/[[{]/);
    if (firstOpen < 0) return null;
    const startAbs = startScan + firstOpen;
    const openCh = inner[startAbs];
    const closeCh = openCh === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startAbs; i < inner.length; i++) {
        const ch = inner[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === openCh) {
            depth++;
        } else if (ch === closeCh) {
            depth--;
            if (depth === 0) return inner.slice(startAbs, i + 1);
        }
    }
    return null;
}

export function parseAskUserContext(text: string): ParsedAskUserContext | null {
    const inner = extractBalanced(text, OPEN_TAG, CLOSE_TAG);
    if (inner === null) return null;
    const qText = extractJsonBlock(inner, QUESTIONS_HEADER);
    const aText = extractJsonBlock(inner, ANSWERS_HEADER);
    if (qText === null || aText === null) return null;
    try {
        const questions = JSON.parse(qText) as AskUserQuestion[];
        const answers = JSON.parse(aText) as Record<string, string | string[]>;
        if (!Array.isArray(questions) || typeof answers !== "object" || answers === null) {
            return null;
        }
        return { questions, answers };
    } catch {
        return null;
    }
}

/** Minimal structure for reading fields — not tightly coupled to AgentMessage
 *  so it accepts SessionTreeEntry too. */
interface RehydrateMsgLike {
    role?: string;
    content?: string | unknown[];
    toolName?: string;
    toolCallId?: string;
    details?: unknown;
}

/** Entry shape — no index signature to avoid colliding with SessionTreeEntry / AgentMessage. */
export interface AskUserRehydrateEntry {
    type: string;
    message?: RehydrateMsgLike;
    payload?: Record<string, unknown>;
}

/**
 * Single-pass scan of entries: tracks the most recent askUser toolResult
 * candidate; when an ask_user_context user message is encountered, backfills
 * its details. Returns a new (shallow-copied) array; the injected user
 * message itself is preserved — the history-exit hidden stripper will swallow
 * it before the UI sees it.
 */
export function rehydrateAskUserDetails<T extends AskUserRehydrateEntry>(entries: T[]): T[] {
    if (entries.length === 0) return entries;

    const out: T[] = [];
    let candidateIdx = -1;
    let candidateAlreadyHasAnswers = false;

    for (const raw of entries) {
        if (!raw || typeof raw !== "object") {
            out.push(raw);
            continue;
        }

        const isMessageShape = "message" in raw && raw.message !== undefined;
        const msg: RehydrateMsgLike | undefined = isMessageShape
            ? (raw.message as RehydrateMsgLike)
            : (raw.payload as RehydrateMsgLike | undefined);

        // Unrecognized: pass through unchanged.
        if (!msg || typeof msg !== "object") {
            out.push(raw);
            continue;
        }

        const role = msg.role;

        if (role === "toolResult" && msg.toolName === "askUser") {
            const existing = msg.details as { answers?: unknown } | undefined;
            const hasAnswers = hasNonEmptyAnswers(existing?.answers);
            // Shallow-copy message so we can safely mutate details.
            const cloned: T = { ...raw };
            if (isMessageShape) {
                cloned.message = { ...msg };
            } else {
                cloned.payload = { ...(raw.payload as Record<string, unknown>) };
            }
            candidateIdx = out.length;
            candidateAlreadyHasAnswers = hasAnswers;
            out.push(cloned);
            continue;
        }

        if (role === "user" && candidateIdx >= 0 && !candidateAlreadyHasAnswers) {
            const text = userMessageText(msg);
            const parsed = text !== null ? parseAskUserContext(text) : null;
            if (parsed !== null) {
                const target = out[candidateIdx];
                const targetMsgField = (target as { message?: RehydrateMsgLike }).message;
                const targetPayloadField = (target as { payload?: Record<string, unknown> })
                    .payload;
                const targetMsg: RehydrateMsgLike | undefined = targetMsgField
                    ? { ...targetMsgField }
                    : targetPayloadField
                      ? ({ ...targetPayloadField } as RehydrateMsgLike)
                      : undefined;
                if (targetMsg) {
                    const prevDetails =
                        (targetMsg.details as Record<string, unknown> | undefined) ?? {};
                    targetMsg.details = {
                        ...prevDetails,
                        questions: parsed.questions,
                        answers: parsed.answers,
                        answered: true,
                        waiting: false,
                    };
                    if (targetMsgField) {
                        (target as { message: RehydrateMsgLike }).message = targetMsg;
                    } else if (targetPayloadField) {
                        (target as { payload: Record<string, unknown> }).payload =
                            targetMsg as unknown as Record<string, unknown>;
                    }
                    // Lock: candidate is now answered; rare subsequent injections for the
                    // same candidate won't overwrite.
                    candidateAlreadyHasAnswers = true;
                }
            }
        }

        out.push(raw);
    }

    return out;
}

function hasNonEmptyAnswers(answers: unknown): boolean {
    if (answers === null || answers === undefined) return false;
    if (typeof answers !== "object") return false;
    return Object.keys(answers as Record<string, unknown>).length > 0;
}

function userMessageText(msg: RehydrateMsgLike): string | null {
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => {
                const t = (b as { type?: string }).type;
                return t === "text" ? String((b as { text?: unknown }).text ?? "") : "";
            })
            .join("");
    }
    return null;
}
