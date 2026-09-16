/**
 * todoWrite / taskCreate / taskUpdate summaries.
 *
 * All three take arrays or nested objects, which the default summary can only
 * render as a truncated JSON fragment — long enough to fill the head, too
 * mangled to read. These replace it with progress counts.
 *
 * Deliberately data-only (counts, ids, the model's own task text): a summary is
 * a plain function, not a component, so it has no `useT`, and anything with
 * prose in it would be stuck in one language.
 */

import type { UiToolCall } from "../../lib/chat/chatUtils";
import { truncate } from "./_util";
import { toolViews } from "./registry";

interface TodoItem {
    content?: unknown;
    status?: unknown;
}

/** Items with a usable content string; anything malformed is skipped. */
function extractItems(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) return [];
    return value.filter((x): x is TodoItem => Boolean(x) && typeof x === "object");
}

/**
 * `2/5 · <in-progress item>` — done count over total, then what is being worked
 * on. The in-progress content is the model's own text, already in the user's
 * language.
 */
function summarizeTodos(items: TodoItem[]): string {
    if (items.length === 0) return "";
    const done = items.filter((x) => x.status === "completed" || x.status === "failed").length;
    const progress = `${done}/${items.length}`;
    const active = items.find((x) => x.status === "in_progress");
    const label = typeof active?.content === "string" ? active.content : "";
    return label === "" ? progress : `${progress} · ${truncate(label, 60)}`;
}

function summarizeTodoWrite(tool: UiToolCall): string {
    const args = (tool.args ?? {}) as { todos?: unknown };
    return summarizeTodos(extractItems(args.todos));
}

/** `listName · 0/3` — the list being created, then its initial progress. */
function summarizeTaskCreate(tool: UiToolCall): string {
    const args = (tool.args ?? {}) as { listName?: unknown; tasks?: unknown };
    const progress = summarizeTodos(extractItems(args.tasks));
    const name = typeof args.listName === "string" ? truncate(args.listName, 40) : "";
    if (name === "") return progress;
    return progress === "" ? name : `${name} · ${progress}`;
}

/**
 * `<taskId> · completed` — the status is a schema literal, shown verbatim
 * rather than translated: it is the same value the model wrote.
 */
function summarizeTaskUpdate(tool: UiToolCall): string {
    const args = (tool.args ?? {}) as { taskId?: unknown; updates?: unknown };
    const id = typeof args.taskId === "string" ? args.taskId : "";
    const updates = (args.updates ?? {}) as { status?: unknown };
    const status = typeof updates.status === "string" ? updates.status : "";
    if (id === "" && status === "") return "";
    if (status === "") return id;
    return id === "" ? status : `${id} · ${status}`;
}

toolViews.todoWrite = { summary: summarizeTodoWrite };
toolViews.taskCreate = { summary: summarizeTaskCreate };
toolViews.taskUpdate = { summary: summarizeTaskUpdate };
