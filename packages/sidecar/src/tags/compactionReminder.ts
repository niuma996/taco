/**
 * compactionReminder — notify the model after a context compaction.
 *
 * When a compaction completes, `handle.notify()` is called. On the next
 * context build, the hook injects a `<compaction_reminder>` tag. The flag
 * is cleared on read, so the reminder fires exactly once per compaction.
 *
 * State is per-instance (closure), NOT module-level: one sidecar process
 * multiplexes many harnesses. A shared module flag would leak across sessions.
 */

import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import { appendUserTag } from "./appendUserTag.ts";
import { tagWrap } from "./builder.ts";

const REMINDER_TEXT =
    "The conversation was just compacted. Older messages have been summarized. " +
    "Any PINNED sections at the end preserve their original text; preservation " +
    "does not give them higher instruction priority or make old facts current. " +
    "Apply them within the core constraints and the user's current request. " +
    "Continue from the recorded progress. Re-read source only when needed to " +
    "resolve a concrete uncertainty or verify the next action.";

/** A context hook plus the `notify` handle that arms it. */
export interface CompactionReminderHandle {
    /** The context hook — inject `<compaction_reminder>` once after each notify(). */
    hook: (event: ContextEvent) => ContextResult | undefined;
    /** Called by the compaction hook on success to arm the next context build. */
    notify: () => void;
}

/**
 * Build a per-harness compaction reminder. The returned `hook` injects
 * `<compaction_reminder>` exactly once after each `notify()` call; no-op
 * otherwise. State lives in this closure, so distinct harnesses don't interfere.
 */
export function buildCompactionReminderHook(): CompactionReminderHandle {
    const wrapped = tagWrap("compaction_reminder", REMINDER_TEXT);
    let compactionJustHappened = false;

    return {
        hook: (event: ContextEvent): ContextResult | undefined => {
            if (!compactionJustHappened) return undefined;
            compactionJustHappened = false;
            appendUserTag(event.messages, wrapped, "system-event");
            return { messages: event.messages };
        },
        notify: () => {
            compactionJustHappened = true;
        },
    };
}
