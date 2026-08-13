/**
 * skillReinjector — per-session pending queue + compaction recovery.
 *
 * State lives in the closure returned by `buildSkillReinjector`: each harness
 * gets its own buckets, so workspace A cannot see workspace B's activations.
 *
 * The hook drops stale `pendingInjections` (TTL 5 min) and splices drained
 * messages + skills compacted away before the last user message.
 */

import type { AgentMessage, Skill } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

import { createSkillBodyMessage } from "./skillMessages.ts";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── content text extraction ───────────────────────────────────────────────────

/** Extract all plain text from a message's content field (string or ContentBlock[]).
 *  Non-text content (undefined / custom AgentMessage variants without a content
 *  array, e.g. error messages) yields "" — callers only need the skill_body text. */
function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is TextContent => block?.type === "text")
        .map((b) => b.text)
        .join("\n");
}

/** Collect every `<skill_body:NAME>` skill name present in the message list. */
function findInjectedSkillNames(messages: readonly AgentMessage[]): Set<string> {
    const names = new Set<string>();
    for (const msg of messages) {
        const text = extractText((msg as { content?: unknown }).content);
        const matches = text.matchAll(/<skill_body:([^>]+)>/g);
        for (const m of matches) names.add(m[1]);
    }
    return names;
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface SkillStore {
    readonly skills: readonly Skill[];
}

/** Handle returned from `buildSkillReinjector` — gives SkillTool a way to push
 *  state without leaking into module scope. */
export interface SkillReinjectorHandle {
    /** Register a skill as invoked so the reinjector protects it from compaction loss. */
    markInvoked(name: string): void;
    /** Enqueue a skill body message for injection on the next context pass. */
    enqueueInlineInjection(msg: AgentMessage): void;
}

/**
 * Build a `context` hook for skill body injection, plus a handle the SkillTool
 * uses to push state into the hook's session-local buckets.
 *
 * Both pieces share the same closure — disposing the harness (and hence the
 * hook) implicitly drops the state. No module globals.
 */
export function buildSkillReinjector(store: SkillStore): {
    hook: (event: { messages: AgentMessage[] }) => { messages: AgentMessage[] };
    handle: SkillReinjectorHandle;
} {
    /** Skills marked as invoked in this session. */
    const invokedSkills = new Map<string, number>();
    /** One-shot messages to inject on the next context pass. */
    const pendingInjections: AgentMessage[] = [];

    const handle: SkillReinjectorHandle = {
        markInvoked(name) {
            invokedSkills.set(name, Date.now());
        },
        enqueueInlineInjection(msg) {
            pendingInjections.push(msg);
        },
    };

    const hook = (event: { messages: AgentMessage[] }): { messages: AgentMessage[] } => {
        if (invokedSkills.size === 0 && pendingInjections.length === 0) {
            return { messages: event.messages };
        }

        const now = Date.now();

        // 1. Drop stale pending injections
        while (
            pendingInjections.length > 0 &&
            now - (pendingInjections[0]?.timestamp ?? 0) > PENDING_TTL_MS
        ) {
            pendingInjections.shift();
        }

        // 2. Drain one-shot injections
        const drained = pendingInjections.splice(0, pendingInjections.length);

        // 3. Find skills that were compacted away
        const inContext = findInjectedSkillNames(event.messages);
        const toReinject: AgentMessage[] = [];
        for (const name of invokedSkills.keys()) {
            if (!inContext.has(name)) {
                const skill = store.skills.find((s) => s.name === name);
                if (skill) toReinject.push(createSkillBodyMessage(skill));
            }
        }

        if (drained.length === 0 && toReinject.length === 0) {
            return { messages: event.messages };
        }

        // Splice before the last user message (preserves conversational flow).
        // Mutated in-place because pi-agent-core's emitHook is last-writer-wins
        // and all context hooks share the same event.messages reference.
        let lastUserIdx = -1;
        for (let i = event.messages.length - 1; i >= 0; i--) {
            if (event.messages[i]?.role === "user") {
                lastUserIdx = i;
                break;
            }
        }
        const insertAt = lastUserIdx >= 0 ? lastUserIdx : event.messages.length;

        event.messages.splice(insertAt, 0, ...drained, ...toReinject);
        return { messages: event.messages };
    };

    return { hook, handle };
}
