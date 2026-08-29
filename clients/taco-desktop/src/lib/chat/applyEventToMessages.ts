/**
 * applyEventToMessages — apply a single session event to the messages list,
 * returning new messages + a pending-clear flag.
 *
 * Design notes:
 *  - Pure: doesn't read external state. All dependencies (messages /
 *    suppressedThinking) come in as parameters, so reducers see a snapshot
 *    of state without stale closures.
 *  - Immutability: never mutates the input `messages`; returns a new array.
 *  - No unstable time sources (Date.now, etc.) — callers pass `now` so tests
 *    stay deterministic.
 *
 * Protocol quirk: `assistantMessageEvent` is a direct field on
 * message_update events (sibling of `message`), NOT under `ev.message`.
 * Reading from the wrong place yields `undefined` and every streaming update
 * on the same message collides on one fingerprint — then dedup swallows
 * them. The protocol doesn't expose this field in the types, so we tolerate
 * the narrowing here (note kept at top).
 */

import type { AgentMessage } from "@taco-ai/protocol";
import type { AssistantSubEvent, SessionEventLike, UiMessage, UiToolCall } from "./chatUtils.ts";
import {
    extractAssistantTextAndThinking,
    extractImageParts,
    findLastAssistant,
    stringifyResult,
    textFromMessage,
    toolResultLine,
} from "./chatUtils.ts";

type AssistantMessage = Extract<UiMessage, { kind: "assistant" }>;

/** safeStringify — returns "" when JSON.stringify throws. */
function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return "";
    }
}

// Upsert a tool card in the most recent assistant message's tools[] —
// replace the entry when the same toolCallId comes in.
function upsertTool(tools: UiToolCall[], incoming: UiToolCall): void {
    const idx = tools.findIndex((t) => t.id === incoming.id);
    if (idx >= 0) {
        tools[idx] = { ...tools[idx], ...incoming };
    } else {
        tools.push(incoming);
    }
}

/** Shallow-clone an assistant bubble (text/thinking/tools arrays cloned; element objects are not mutated on the input). */
function cloneAssistant(a: AssistantMessage): AssistantMessage {
    return {
        ...a,
        tools: a.tools.map((t) => ({ ...t })),
        thinking: a.thinking.map((b) => ({ ...b })),
    };
}

export interface ApplyEventOpts {
    /**
     * When the current session's thinking level is `off`, drop streaming
     * thinking_* sub-events so newly-sent prompts don't render their thinking
     * process. Historical thinking blocks (already rendered) stay visible —
     * only the live accumulation is suppressed in mergeEvent; the messages
     * history itself isn't touched.
     */
    suppressedThinking: boolean;
    /** Current wall clock (ms) — used for thinking block startedAt / endedAt and fallback ts. */
    now: number;
}

export interface ApplyEventResult {
    /** Post-event messages list (may share reference with input when nothing changed). */
    messages: UiMessage[];
    /**
     * True when agent_end / turn_end was received (so UI can flip `pending`
     * off); other events pass through `prevPending` (caller merges itself).
     */
    clearPending: boolean;
}

/**
 * Apply a single session event to the messages list, producing new messages
 * and a pending-clear flag. Dispatches to a per-type handler; terminal events
 * (agent_end / turn_end) only flip `clearPending`.
 */
export function applyEventToMessages(
    messages: UiMessage[],
    ev: SessionEventLike,
    opts: ApplyEventOpts,
): ApplyEventResult {
    switch (ev.type) {
        case "message_start":
            return handleMessageStart(messages, ev, opts);
        case "message_update":
            return handleMessageUpdate(messages, ev, opts);
        case "message_end":
            return handleMessageEnd(messages, ev, opts);
        case "tool_execution_start":
            return handleToolStart(messages, ev, opts);
        case "tool_execution_update":
            return handleToolUpdate(messages, ev);
        case "tool_execution_end":
            return handleToolEnd(messages, ev, opts);
        case "agent_end":
        case "turn_end":
            return { messages, clearPending: true };
        default:
            // Unknown event type — leave messages untouched, don't clear pending.
            return { messages, clearPending: false };
    }
}

function handleMessageStart(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "message_start" }>,
    opts: ApplyEventOpts,
): ApplyEventResult {
    if (ev.message?.role !== "assistant") return { messages, clearPending: false };
    const ts = String(ev.message.timestamp ?? opts.now);
    const id = `live-asst-${ts}`;
    if (messages.some((x) => x.id === id)) return { messages, clearPending: false };
    return {
        messages: [
            ...messages,
            { id, kind: "assistant", text: "", ts: opts.now, tools: [], thinking: [] },
        ],
        clearPending: false,
    };
}

function handleMessageUpdate(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "message_update" }>,
    opts: ApplyEventOpts,
): ApplyEventResult {
    if (ev.message?.role !== "assistant") return { messages, clearPending: false };
    const ts = String(ev.message.timestamp ?? "");
    const idx = messages.findIndex((x) => x.kind === "assistant" && x.id === `live-asst-${ts}`);
    if (idx < 0) return { messages, clearPending: false };
    const sub: AssistantSubEvent | undefined = ev.assistantMessageEvent;
    if (!sub) return { messages, clearPending: false };
    // Clone the assistant bubble before mutating, to keep the pure-function contract.
    const target = messages[idx];
    if (target?.kind !== "assistant") return { messages, clearPending: false };
    const cloned = cloneAssistant(target);
    applyAssistantSubEvent(cloned, sub, opts);
    const next = messages.slice();
    next[idx] = cloned;
    return { messages: next, clearPending: false };
}

function handleMessageEnd(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "message_end" }>,
    opts: ApplyEventOpts,
): ApplyEventResult {
    const m = ev.message;
    if (!m) return { messages, clearPending: false };
    if (m.role === "user") {
        const id = `live-user-${m.timestamp ?? opts.now}`;
        if (messages.some((existing) => existing.id === id))
            return { messages, clearPending: false };
        // Server-pushed user message snapshots can also carry image parts —
        // extract them onto UiMessage.images so history shows them in the UI.
        // Note: optimistic-pushed user bubbles already have attachments written;
        // dedup-by-id prevents a late server push from stacking on top, and the
        // `images` field keeps the optimistic copy.
        const images = extractImageParts(m.content);
        const text = textFromMessage(m);
        // Optimistic user message already on screen (from sendPrompt's lazy
        // branch): swap it for the server entry in place — match by text
        // AND images (length + first image's data prefix) so two optimistic
        // entries with the same text but different attachments don't get
        // conflated and lose one set of images. If no optimistic entry
        // matches, append the server entry normally.
        const serverImageSig =
            images.length === 0 ? "" : `${images.length}:${images[0]?.data?.slice(0, 16) ?? ""}`;
        const optimisticIdx = messages.findIndex((x) => {
            if (x.kind !== "user" || !x.id.startsWith("optimistic-user-") || x.text !== text) {
                return false;
            }
            const xImages = x.images ?? [];
            if (xImages.length === 0) return serverImageSig === "";
            const xSig = `${xImages.length}:${xImages[0]?.data?.slice(0, 16) ?? ""}`;
            return xSig === serverImageSig;
        });
        if (optimisticIdx >= 0) {
            const next = messages.slice();
            next[optimisticIdx] = {
                id,
                kind: "user",
                text,
                ts: opts.now,
                ...(images.length > 0 ? { images } : {}),
            };
            return { messages: next, clearPending: false };
        }
        return {
            messages: [
                ...messages,
                {
                    id,
                    kind: "user",
                    text,
                    ts: opts.now,
                    ...(images.length > 0 ? { images } : {}),
                },
            ],
            clearPending: false,
        };
    }
    if (m.role === "assistant") {
        const ts = String(m.timestamp ?? "no-ts");
        const id = `live-asst-${ts}`;
        const idx = messages.findIndex((x) => x.kind === "assistant" && x.id === id);
        if (idx < 0) {
            // We narrowed m.role === "assistant" above; the function internally
            // checks role again, so the wider MessageLike is safe here.
            const { text, thinking } = extractAssistantTextAndThinking(m as AgentMessage);
            return {
                messages: [
                    ...messages,
                    { id, kind: "assistant", text, ts: opts.now, tools: [], thinking },
                ],
                clearPending: false,
            };
        }
        const target = messages[idx];
        if (target?.kind !== "assistant") return { messages, clearPending: false };
        const cloned = cloneAssistant(target);
        cloned.text = textFromMessage(m);
        for (let i = 0; i < (m.content?.length ?? 0); i++) {
            const c = (m.content as Array<{ type?: string; redacted?: boolean }>)[i];
            const block = cloned.thinking[i];
            if (c?.type === "thinking" && block && c.redacted) {
                block.redacted = true;
                block.thinking = "";
            }
        }
        const next = messages.slice();
        next[idx] = cloned;
        return { messages: next, clearPending: false };
    }
    return { messages, clearPending: false };
}

function handleToolStart(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "tool_execution_start" }>,
    opts: ApplyEventOpts,
): ApplyEventResult {
    const toolCallId = ev.toolCallId ?? `${opts.now}`;
    const tool: UiToolCall = {
        id: toolCallId,
        name: ev.toolName ?? "tool",
        args: ev.args,
        status: "running",
    };
    const assistant = findLastAssistant(messages);
    if (assistant) {
        const cloned = cloneAssistant(assistant);
        upsertTool(cloned.tools, tool);
        const idx = messages.lastIndexOf(assistant);
        const next = messages.slice();
        next[idx] = cloned;
        return { messages: next, clearPending: false };
    }
    return {
        messages: [
            ...messages,
            {
                id: `tool-call-${toolCallId}`,
                kind: "tool",
                text: `▶ ${tool.name}`,
                ts: opts.now,
            },
        ],
        clearPending: false,
    };
}

function handleToolUpdate(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "tool_execution_update" }>,
): ApplyEventResult {
    const toolCallId = ev.toolCallId ?? "";
    const assistant = findLastAssistant(messages);
    if (!assistant) return { messages, clearPending: false };
    const t = assistant.tools.find((x) => x.id === toolCallId);
    if (!t || ev.partialResult === undefined) return { messages, clearPending: false };
    const cloned = cloneAssistant(assistant);
    const clonedTool = cloned.tools.find((x) => x.id === toolCallId);
    if (!clonedTool) return { messages, clearPending: false };
    clonedTool.resultText =
        typeof ev.partialResult === "string" ? ev.partialResult : safeStringify(ev.partialResult);
    const idx = messages.lastIndexOf(assistant);
    const next = messages.slice();
    next[idx] = cloned;
    return { messages: next, clearPending: false };
}

function handleToolEnd(
    messages: UiMessage[],
    ev: Extract<SessionEventLike, { type: "tool_execution_end" }>,
    opts: ApplyEventOpts,
): ApplyEventResult {
    const toolCallId = ev.toolCallId ?? "";
    const name = ev.toolName ?? "tool";
    const assistant = findLastAssistant(messages);
    if (!assistant) {
        return {
            messages: [
                ...messages,
                {
                    id: `tool-result-${toolCallId}`,
                    kind: "tool",
                    text: toolResultLine(name, ev.isError ?? false, stringifyResult(ev.result)),
                    ts: opts.now,
                },
            ],
            clearPending: false,
        };
    }
    const t = assistant.tools.find((x) => x.id === toolCallId);
    if (!t) {
        return {
            messages: [
                ...messages,
                {
                    id: `tool-result-${toolCallId}`,
                    kind: "tool",
                    text: toolResultLine(name, ev.isError ?? false, stringifyResult(ev.result)),
                    ts: opts.now,
                },
            ],
            clearPending: false,
        };
    }
    const cloned = cloneAssistant(assistant);
    const clonedTool = cloned.tools.find((x) => x.id === toolCallId);
    if (!clonedTool) return { messages, clearPending: false };
    clonedTool.status = ev.isError ? "error" : "ok";
    // For tool cards embedded in assistant: store the raw result text (matches
    // the history path) and let the renderer handle truncation. We
    // don't prepend "✓ name:" — that prefix is for fallback rows.
    clonedTool.resultText = stringifyResult(ev.result);
    // Pass through structured `details` — front-end views parse by
    // tool.name (e.g. edit's details.lines for absolute line numbers).
    //
    // askUser / planExit's second tool_execution_end loses fields,
    // so we merge from the previous frame's tool card:
    //   - askUser: drops questions (returned details contain only answers)
    //   - planExit: drops questions + planContent (returned details
    //     contain only `approved`; planContent is intentionally ""
    //     because planExit's second branch skipped readFileSync)
    // Without the merge, the UI falls back to "Waiting for questions…"
    // or an empty plan preview.
    const prevDetails = clonedTool.details as
        | { questions?: unknown; planContent?: unknown }
        | undefined;
    const newDetails = ev.result?.details;
    if (name === "askUser" || name === "planExit") {
        const newObj =
            newDetails && typeof newDetails === "object"
                ? (newDetails as Record<string, unknown>)
                : {};
        const merged: Record<string, unknown> = { ...newObj };
        if (prevDetails?.questions !== undefined) {
            merged.questions = prevDetails.questions;
        }
        if (name === "planExit" && prevDetails?.planContent !== undefined) {
            // planContent: prefer the new value (if a future planExit revision provides
            // it again); otherwise fall back to the previous frame's value.
            if (merged.planContent === undefined || merged.planContent === "") {
                merged.planContent = prevDetails.planContent;
            }
        }
        clonedTool.details = merged;
    } else {
        clonedTool.details = newDetails;
    }
    const idx = messages.lastIndexOf(assistant);
    const next = messages.slice();
    next[idx] = cloned;
    return { messages: next, clearPending: false };
}

/**
 * Apply a single assistantMessageEvent sub-event (text / thinking / toolcall)
 * to the assistant bubble. Mutates the bubble in place, but callers MUST
 * pass a cloned copy (see cloneAssistant) to honor the pure-function contract.
 */
function applyAssistantSubEvent(
    assistant: AssistantMessage,
    sub: AssistantSubEvent,
    opts: ApplyEventOpts,
): void {
    switch (sub.type) {
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
            if (opts.suppressedThinking) break;
            if (sub.type === "thinking_start") {
                const idx = sub.contentIndex ?? 0;
                assistant.thinking[idx] = { thinking: "", startedAt: opts.now };
            } else if (sub.type === "thinking_delta") {
                const idx = sub.contentIndex ?? 0;
                const block = assistant.thinking[idx];
                if (block && !block.redacted && sub.delta) block.thinking += sub.delta;
            } else {
                const idx = sub.contentIndex ?? 0;
                const block = assistant.thinking[idx];
                if (block) {
                    block.endedAt = opts.now;
                    block.completedCount = (block.completedCount ?? 0) + 1;
                    block.thinking = sub.content || block.thinking;
                    const finalBlock = sub.partial?.content?.[idx];
                    if (finalBlock && finalBlock.type === "thinking" && finalBlock.redacted) {
                        block.redacted = true;
                        block.thinking = "";
                    }
                }
            }
            break;
        case "text_delta":
            if (sub.delta) assistant.text += sub.delta;
            break;
        case "text_start":
        case "text_end":
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
        case "start":
        case "done":
        case "error":
            // toolcall_* events are handled separately via tool_execution_*.
            break;
    }
}
