/**
 * todoWriteReminder — nag the model when it hasn't used TodoWrite in a while.
 *
 * Scans recent messages for TodoWrite tool calls. If the model has not updated
 * its task list for `TURNS_BETWEEN_REMINDERS` assistant turns AND there are
 * unfinished tasks on the active list, injects a `<todo_reminder>` tag.
 *
 * Throttling counter is the number of assistant messages in context (not
 * calendar time), since that's what both the model and the tag system see.
 */

import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import { createUserMessage, tagWrap } from "../tags/builder.ts";
import { findActiveListId } from "./activeList.ts";
import type { TaskStore } from "./taskTypes.ts";
import { isUnfinishedStatus } from "./taskTypes.ts";

/**
 * Number of assistant turns without a TodoWrite call before we remind.
 * 10 turns ≈ 5-10 minutes of real time for a moderately fast model.
 */
const TURNS_BETWEEN_REMINDERS = 10;

/**
 * Maximum number of assistant messages to scan; beyond this, even a 10-turn
 * streak is ancient history and we don't want to burn tokens scanning.
 */
const MAX_SCAN_DEPTH = 40;

/**
 * Count of consecutive assistant messages (role: "assistant") that do NOT
 * contain a `todoWrite` tool call in their content blocks.
 *
 * We look for `type: "toolCall"` blocks where `"name": "todoWrite"`.
 * Scanning walks backward from the newest message: `toolResult` messages are
 * skipped (not counted), only `assistant` turns increment the counter, and the
 * first `user` message ends the scan (we're now before the current turn).
 */
function countConsecutiveTurnsWithoutTodoWrite(messages: ContextEvent["messages"]): number {
    let count = 0;
    // Scan from the end backwards — most recent messages are more relevant.
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - MAX_SCAN_DEPTH; i--) {
        const msg = messages[i];
        if (!msg) continue;
        if (msg.role === "user") break; // stop at any user message → we're past the current turn
        if (msg.role !== "assistant") continue;
        count++;
        const content = (msg as { content?: unknown }).content;
        if (Array.isArray(content)) {
            const hasTodoWrite = (content as Array<{ type?: string; name?: string }>).some(
                (block) => block?.type === "toolCall" && block?.name === "todoWrite",
            );
            if (hasTodoWrite) return 0; // found a TodoWrite → streak broken
        }
    }
    return count;
}

const REMINDER_TEXT =
    "You haven't updated your task list (TodoWrite) in a while. " +
    "If the current task state is stale, call TodoWrite to update it — " +
    "mark completed tasks as done, add new ones as needed. " +
    "This helps track progress and keeps the user informed.";

export function buildTodoWriteReminderContextHook(
    getTaskStore: () => TaskStore,
): (event: ContextEvent) => ContextResult | undefined {
    const wrapped = tagWrap("todo_reminder", REMINDER_TEXT);

    return (event: ContextEvent): ContextResult | undefined => {
        // Only remind if there are active unfinished tasks.
        const store = getTaskStore();
        const activeId = store.currentListId ?? findActiveListId(store);
        if (!activeId) return undefined;
        const list = store.lists.get(activeId);
        if (!list) return undefined;
        const hasUnfinished = list.tasks.some((t) => isUnfinishedStatus(t.status));
        if (!hasUnfinished) return undefined;

        const streak = countConsecutiveTurnsWithoutTodoWrite(event.messages);
        if (streak < TURNS_BETWEEN_REMINDERS) return undefined;

        event.messages.unshift(createUserMessage(wrapped));
        return { messages: event.messages };
    };
}
