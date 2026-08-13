/**
 * Chat UI helpers — translate harness / server event payloads into
 * renderable text and UI models.
 *
 * Deliberately pure: React components import these functions to render
 * messages without depending on any React state.
 *
 * Tightly coupled to the server's SessionHistoryEntry.payload field and
 * to AgentHarness event formats. Notify server / shared when changing.
 */

import type { AgentMessage, ImageInput } from "@taco-ai/protocol";

export interface ContentPart {
    type?: string;
    text?: string;
    thinking?: string;
    redacted?: boolean;
}

export interface MessageLike {
    role?: string;
    content?: string | ContentPart[];
    timestamp?: string | number;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    args?: unknown;
}

/** Sub-event shape inside message_update — protocol doesn't expose this field,
 * so applyEventToMessages treats it as an opaque tagged payload. */
export interface AssistantSubEvent {
    type?: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: { content?: Array<{ type?: string; redacted?: boolean }> };
}

/**
 * Discriminated union of session events the UI consumes.
 *
 * Each branch declares the fields the renderer actually reads, so the type
 * system enforces per-branch invariants instead of requiring runtime casts
 * downstream. `assistantMessageEvent` lives on `message_update` (not on
 * `ev.message`) — the harness emits it as a sibling field; reading from the
 * wrong place silently breaks streaming dedup. See applyEventToMessages
 * header for the wire detail.
 */
export type SessionEventLike =
    | {
          type: "message_start";
          message?: MessageLike & { role: "assistant" };
      }
    | {
          type: "message_update";
          message?: MessageLike & { role: "assistant" };
          /** Streamed sub-event (text_delta / thinking_* / toolcall_*) — sibling of `message`, not under it. */
          assistantMessageEvent?: AssistantSubEvent;
      }
    | {
          type: "message_end";
          message?: MessageLike;
      }
    | {
          type: "tool_execution_start";
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
      }
    | {
          type: "tool_execution_update";
          toolCallId?: string;
          partialResult?: unknown;
      }
    | {
          type: "tool_execution_end";
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
          partialResult?: unknown;
          result?: {
              content?: Array<{ type?: string; text?: string }>;
              details?: unknown;
          };
          isError?: boolean;
      }
    | { type: "agent_end" }
    | { type: "turn_end" };

/** Shape of session.event.params from server push. */
export interface SessionEventParams {
    event?: SessionEventLike;
}

/** Display long paths in a shortened form (avoid widening the sidebar). */
export function shortPath(p: string): string {
    if (p.length < 24) return p;
    return `…${p.slice(-22)}`;
}

/** Render a harness AgentMessage to plain text (for chat rows). */
export function textFromMessage(m: MessageLike | undefined): string {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
        return m.content
            .filter((c) => c?.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");
    }
    return JSON.stringify(m);
}

/** Single-line text for the fallback tool row (✗ name (error): ... / ✓ name: ...). */
export function toolResultLine(name: string, isError: boolean, result: unknown): string {
    const text = stringifyResult(result);
    const trimmed = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    if (isError) {
        return `✗ ${name} (error)${trimmed ? `: ${trimmed}` : ""}`;
    }
    if (!result) return `✓ ${name}`;
    return `✓ ${name}${trimmed ? `: ${trimmed}` : ""}`;
}

/** Fold tool_result.content / string / arbitrary object into a readable single string. */
export function stringifyResult(r: unknown): string {
    if (!r) return "";
    if (typeof r === "string") return r;
    if (Array.isArray((r as { content?: unknown })?.content)) {
        const content = (r as { content: Array<{ type?: string; text?: string }> }).content;
        return content
            .filter((c) => c?.type === "text" && c.text)
            .map((c) => c.text as string)
            .join("\n");
    }
    try {
        return JSON.stringify(r);
    } catch {
        return "";
    }
}

// ────────────────────────────────────────────────────────────────────
// New UI model: tool calls merged into the assistant message.
// ────────────────────────────────────────────────────────────────────

export type ToolCallStatus = "running" | "ok" | "error";

export interface UiToolCall {
    /** Link id: ToolCall.id === ToolResultMessage.toolCallId. */
    id: string;
    name: string;
    args: unknown;
    status: ToolCallStatus;
    /** Filled on completion; during `running` it's the stringified partialResult. */
    resultText?: string;
    /**
     * Tool-specific structured details (passed through from
     * tool_execution_end.result.details on the server). The edit tool writes
     * { edits: number, lines: LineInfo[] } etc.; the front-end parses by
     * tool.name. `stringifyResult` does not read this field — `resultText`
     * and `details` are complementary.
     */
    details?: unknown;
}

export interface UiThinkingBlock {
    /** Accumulated thinking text. */
    thinking: string;
    /**
     * Wall-clock ms at thinking_start. 0 when the block was reconstructed from
     * persisted session history and the exact start time is unknown — kept as
     * a number (not undefined) so renderers can rely on a finite value.
     */
    startedAt?: number;
    /**
     * Wall-clock ms at thinking_end. 0 for historical blocks (exact end
     * unknown); left unset while the block is still streaming.
     */
    endedAt?: number;
    /** True when this block was reconstructed from persisted session history. */
    isHistorical?: boolean;
    /** Safety-filter flag; when true the renderer shows "Thinking (redacted)" instead of the body. */
    redacted?: boolean;
    /**
     * Bumped each time the block transitions streaming → complete. Lets the
     * renderer reset its collapse state on completion (streaming blocks stay
     * open, completed blocks auto-collapse) without a derived-state effect.
     */
    completedCount?: number;
}

export type UiMessage =
    | { id: string; kind: "user"; text: string; ts: number; images?: ImageInput[] }
    | {
          id: string;
          kind: "assistant";
          text: string;
          ts: number;
          tools: UiToolCall[];
          /** Thinking blocks in arrival order; may be empty (models without thinking). */
          thinking: UiThinkingBlock[];
      }
    | { id: string; kind: "tool"; text: string; ts: number } // orphan toolResult fallback render (no matching ToolCall)
    | { id: string; kind: "system"; text: string; ts: number };

/** History-entry shape (inferred from SessionHistoryEntry). */
export interface HistoryEntryLike {
    id?: unknown;
    type?: string;
    payload?: unknown;
    timestamp?: string | number;
}

/** Derive a one-line summary from `args` (for card headers). Prefer path/command/file_path; fall back to truncated JSON.stringify. */
export function summarizeToolArgs(_name: string, args: unknown): string {
    if (!args || typeof args !== "object") return "";
    const a = args as Record<string, unknown>;
    for (const k of ["path", "file_path", "filePath", "command"]) {
        const v = a[k];
        if (typeof v === "string" && v.length > 0) {
            // Path-like tools show the short path; command-like tools show the command verbatim.
            if (k === "command") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
            return shortPath(v);
        }
    }
    try {
        const s = JSON.stringify(args);
        if (s.length <= 80) return s;
        // Snap the cut to the last token boundary so the JSON doesn't end
        // mid-token (e.g. `"label":…`). A mid-token cut leaves no break
        // opportunity under `word-break: break-all`, so the header wraps at
        // an awkward point inside the args. lastIndexOf returns -1 when no
        // match exists in the scanned range — fall back to a flat 80-char
        // cut so we never slice from offset 0 and produce an empty header.
        const boundary = Math.max(
            s.lastIndexOf(",", 80),
            s.lastIndexOf(":", 80),
            s.lastIndexOf("{", 80),
            s.lastIndexOf("[", 80),
        );
        const end = boundary > 40 ? boundary + 1 : 80;
        return `${s.slice(0, Math.max(end, 1))}…`;
    } catch {
        return "";
    }
}

/**
 * Convert session.history entries to UiMessage list for the UI — tool calls
 * and their results are merged into the parent assistant message.
 *
 * Single pass over entries; payload is expected to be an AgentMessage.
 * Three roles:
 *   user: text row
 *   assistant: text + 0..N tool-call cards (status starts as `running`)
 *   toolResult: locate the matching tool in the most recent assistant and
 *               set status / resultText.
 */
export function historyToUiMessages(entries: HistoryEntryLike[] | undefined): UiMessage[] {
    const out: UiMessage[] = [];
    const seenEntryIds = new Set<string>();

    for (const e of entries ?? []) {
        if (e?.type !== "message") continue;
        const m = e.payload as AgentMessage | undefined;
        if (!m || typeof m !== "object") continue;
        const entryId = String(e.id ?? "");
        if (entryId && seenEntryIds.has(entryId)) continue;
        if (entryId) seenEntryIds.add(entryId);

        const ts = new Date(typeof e.timestamp === "string" ? e.timestamp : Date.now()).getTime();
        // Pull role out of AgentMessage — AgentMessage is the union
        // Message | CustomAgentMessages[...]; we only need
        // user / assistant / toolResult here. Structural check, not a named
        // import, since the union isn't worth pinning.
        const role = (m as { role?: string }).role;
        const content = (m as { content?: unknown }).content;

        if (role === "user") {
            const images = extractImageParts(content);
            out.push({
                id: entryId || `user-${ts}`,
                kind: "user",
                text: stringifyMessageText(content),
                ts,
                ...(images.length > 0 ? { images } : {}),
            });
        } else if (role === "assistant") {
            const { text, tools, thinking } = splitAssistantContent(content);
            out.push({
                id: entryId || `assistant-${ts}`,
                kind: "assistant",
                text,
                ts,
                tools,
                thinking,
            });
        } else if (role === "toolResult") {
            const tm = m as {
                toolCallId: string;
                toolName?: string;
                content?: unknown;
                isError?: boolean;
                details?: unknown;
            };
            const assistant = findLastAssistant(out);
            const resultText = stringifyContent(tm.content);
            if (assistant) {
                const t = assistant.tools.find((x) => x.id === tm.toolCallId);
                if (t) {
                    t.status = tm.isError ? "error" : "ok";
                    t.resultText = resultText;
                    // Structured `details` aligns with the live path (applyEventToMessages) —
                    // askUser's questions / edit's lines etc. are parsed by tool.name.
                    // Without this, on history replay askUser cards lose their
                    // questions and render as empty frames.
                    if (tm.details !== undefined) t.details = tm.details;
                } else {
                    // Orphan toolResult (no matching ToolCall): render as a standalone tool row.
                    out.push({
                        id: entryId || `tool-result-${ts}`,
                        kind: "tool",
                        text: stringifyToolResultLine(tm, resultText),
                        ts,
                    });
                }
            } else {
                out.push({
                    id: entryId || `tool-result-${ts}`,
                    kind: "tool",
                    text: stringifyToolResultLine(tm, resultText),
                    ts,
                });
            }
        }
    }
    expireUnresolvedToolCalls(out);
    return out;
}

/**
 * Tools that spawn a child session and report back only when it finishes. Their
 * toolResult can trail the parent assistant message by minutes, so its absence
 * from a history read carries no information about whether they are still alive.
 */
const LONG_RUNNING_TOOLS = new Set(["agent", "agentContinue", "skill"]);

/**
 * History replay seeds every toolCall as "running" and only the matching
 * toolResult flips it to ok/error. A toolCall with no toolResult means the
 * sidecar died mid-execution (killed while awaiting command approval, crash,
 * workspace disposed) — that turn went with the process, so no result will
 * ever arrive. Leaving it "running" shows a spinner that never resolves.
 *
 * The inference only holds for tools whose result lands on disk in the same
 * breath as the assistant message. `agent` / `skill` spawn a child session and
 * report minutes later, so a history read taken mid-turn legitimately lacks
 * their toolResult — see LONG_RUNNING_TOOLS.
 */
function expireUnresolvedToolCalls(messages: UiMessage[]): void {
    for (const m of messages) {
        if (m.kind !== "assistant") continue;
        for (const tool of m.tools) {
            if (tool.status !== "running") continue;
            // askUser / planExit legitimately stay "running" while waiting for
            // a user answer — their toolResult carries waiting:true and may
            // never arrive on history replay if the user closed the app mid-
            // question. Those are NOT sidecar crashes; skip them so the card
            // keeps its input UI instead of being force-marked error.
            if (tool.name === "askUser" || tool.name === "planExit") {
                const waiting = (tool.details as { waiting?: unknown } | undefined)?.waiting;
                if (waiting === true) continue;
            }
            // A missing toolResult here is the expected mid-turn state, not a
            // crash: expiring it would flip a live subagent card to error and
            // strip `details.subSessionId`, which the agent view surfaces as
            // "no sub-session id (tool failed)". Leaving it "running" is the
            // truthful reading — a real restart is handled by SIDECAR_RESTARTED.
            if (LONG_RUNNING_TOOLS.has(tool.name)) continue;
            tool.status = "error";
            tool.details = {
                ...((tool.details ?? {}) as object),
                reason: "sidecar_restarted",
                exitCode: -1,
                interrupted: false,
            };
        }
    }
}

/** Split an AssistantMessage.content into text + toolCall + thinking lists (tolerates missing / non-array content). */
function splitAssistantContent(content: unknown): {
    text: string;
    tools: UiToolCall[];
    thinking: UiThinkingBlock[];
} {
    const textParts: string[] = [];
    const tools: UiToolCall[] = [];
    const thinking: UiThinkingBlock[] = [];
    if (!Array.isArray(content)) return { text: "", tools, thinking };

    for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: string };
        if (p.type === "text") {
            const txt = (part as { text?: unknown }).text;
            if (typeof txt === "string" && txt.length > 0) textParts.push(txt);
        } else if (p.type === "toolCall") {
            const tc = part as { id: string; name: string; arguments?: unknown };
            tools.push({ id: tc.id, name: tc.name, args: tc.arguments, status: "running" });
        } else if (p.type === "thinking") {
            const t = part as { thinking?: unknown; redacted?: boolean };
            // Historical blocks (replayed from session.jsonl) use 0 for
            // startedAt / endedAt — exact wall-clock ms is unknown; see
            // UiThinkingBlock doc.
            thinking.push({
                thinking: typeof t.thinking === "string" ? t.thinking : "",
                startedAt: 0,
                endedAt: 0,
                isHistorical: true,
                redacted: t.redacted || undefined,
            });
        }
    }
    return { text: textParts.join("\n"), tools, thinking };
}

/**
 * Find askUser / planExit toolCallIds still awaiting user input from
 * hydrated history.
 *
 * Criterion: the last message is an assistant whose tools contain a name in
 * {askUser, planExit} with details.waiting===true. We only inspect the tail —
 * already-answered tools have a newer assistant message after them and
 * won't be the tail, so they can't be misread as pending. The returned ids
 * are used by ATTACH to restore askUserPending so that history-rehydrated
 * askUser / planExit cards behave like the live path on submit.
 */
export function findPendingAskUserIds(messages: UiMessage[]): string[] {
    const last = messages[messages.length - 1];
    if (last?.kind !== "assistant") return [];
    const ids: string[] = [];
    for (const t of last.tools) {
        if (t.name !== "askUser" && t.name !== "planExit") continue;
        const waiting = (t.details as { waiting?: unknown } | undefined)?.waiting;
        if (waiting === true) ids.push(t.id);
    }
    return ids;
}

/** One-shot extract text + thinking from a final AssistantMessage snapshot — used by message_end's error-path fallback. */
export function extractAssistantTextAndThinking(m: AgentMessage | undefined): {
    text: string;
    thinking: UiThinkingBlock[];
} {
    if (!m || (m as { role?: string }).role !== "assistant") {
        return { text: "", thinking: [] };
    }
    const { text, thinking } = splitAssistantContent((m as { content?: unknown }).content);
    return { text, thinking };
}

/** Extract image parts from user message.content — no base64 validation;
 *  trust the format the server writes. Returns an empty array when there are
 *  no images (callers omit the `images` field when undefined).
 *  Exported for applyEventToMessages to reuse — single source of truth for
 *  the extraction lives here in chatUtils. */
export function extractImageParts(content: unknown): ImageInput[] {
    if (!Array.isArray(content)) return [];
    const out: ImageInput[] = [];
    for (const c of content) {
        if (!c || typeof c !== "object") continue;
        const cc = c as { type?: unknown; data?: unknown; mimeType?: unknown };
        if (cc.type !== "image") continue;
        if (typeof cc.data !== "string" || typeof cc.mimeType !== "string") continue;
        out.push({ type: "image", data: cc.data, mimeType: cc.mimeType });
    }
    return out;
}

/** Plain text from a user/general message (text-only parts from the content array, or the string itself). */
function stringifyMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const lines: string[] = [];
        for (const c of content) {
            if (!c || typeof c !== "object") continue;
            const cc = c as { type?: string; text?: unknown };
            if (cc.type === "text") {
                if (typeof cc.text === "string" && cc.text.length > 0) lines.push(cc.text);
            }
        }
        return lines.join("\n");
    }
    return "";
}

/** Collapse a tool result's content (array / string / object) into a single string. */
function stringifyContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const lines: string[] = [];
        for (const c of content) {
            if (!c || typeof c !== "object") continue;
            const cc = c as { type?: string; text?: unknown };
            if (cc.type === "text" && typeof cc.text === "string") {
                lines.push(cc.text);
            }
        }
        return lines.join("\n");
    }
    try {
        return JSON.stringify(content);
    } catch {
        return "";
    }
}

function stringifyToolResultLine(
    tm: { toolName?: string; isError?: boolean },
    content: string,
): string {
    const name = tm.toolName ?? "tool";
    const trimmed = content.length > 240 ? `${content.slice(0, 240)}…` : content;
    if (tm.isError) return `✗ ${name} (error)${trimmed ? `: ${trimmed}` : ""}`;
    return `✓ ${name}${trimmed ? `: ${trimmed}` : ""}`;
}

export function findLastAssistant(
    arr: UiMessage[],
): Extract<UiMessage, { kind: "assistant" }> | undefined {
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m.kind === "assistant") return m;
    }
    return undefined;
}
