/**
 * Strip `ThinkingContent` blocks from assistant messages when the user switches
 * `thinkingLevel` to "off". Anthropic replays signed `ThinkingContent` payloads
 * verbatim even when `thinking: { type: "disabled" }` is declared. This function
 * edits only the in-memory copy; the persisted session is untouched.
 */

function isAssistantWithBlockContent(m: unknown): m is { content: Array<{ type?: unknown }> } {
    if (!m || typeof m !== "object") return false;
    const obj = m as { role?: unknown; content?: unknown };
    return obj.role === "assistant" && Array.isArray(obj.content);
}

export function stripThinkingFromAssistantMessages<M>(messages: ReadonlyArray<M>): M[] {
    let changed = false;
    const next = messages.map((m) => {
        if (!isAssistantWithBlockContent(m)) return m;
        const original = m.content;
        const filtered = original.filter((b) => b?.type !== "thinking");
        if (filtered.length === original.length) return m;
        changed = true;
        return { ...m, content: filtered } as unknown as M;
    });
    // Always return a new array: even when `changed=false` we use `[...messages]` shallow-copy
    // to keep behaviour aligned with the `changed=true` path, preventing a downstream
    // mutate of the returned array from accidentally mutating the original `AgentMessage[]`
    // (especially on harness-reused paths).
    // Note: unchanged messages keep the same reference (`.map` behaviour); changed messages
    // are shallow-copied via spread.
    // Shallow-copy drops own properties beyond `role`+`content` on `AgentMessage`;
    // if a future union adds fields, all fields must be spread here.
    return changed ? next : ([...messages] as M[]);
}
