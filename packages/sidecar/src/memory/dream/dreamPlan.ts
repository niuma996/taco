/**
 * Dream plan — the consolidation actions one LLM call proposes for a
 * workspace, plus the mechanical checks every plan must pass before it can
 * touch a topic file.
 *
 * Three actions, nothing else:
 *   merge   — fold ≥2 topics into one topic with a fresh id; sources are archived
 *   rewrite — replace one topic's content (tighten, fix a contradiction)
 *   archive — retire one topic, with a reason
 * Topics no action names are kept as they are.
 *
 * The model never writes files. It returns JSON; `validateDreamPlan` rejects
 * the whole plan on any inconsistency, so a half-understood plan cannot be
 * partially applied.
 */

import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { extractJsonSpan } from "../../lib/jsonExtract.ts";
import {
    MEMORY_ENTRY_TYPES,
    type MemoryEntry,
    type MemoryEntryType,
    normalizeMemoryTopicId,
} from "../types.ts";

// ─── types ────────────────────────────────────────────────────────────────────

export interface DreamMergeAction {
    readonly action: "merge";
    readonly sourceIds: readonly string[];
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly type: MemoryEntryType;
    readonly content: string;
}

export interface DreamRewriteAction {
    readonly action: "rewrite";
    readonly id: string;
    readonly content: string;
}

export interface DreamArchiveAction {
    readonly action: "archive";
    readonly id: string;
    readonly reason: string;
    /** A kept topic that now holds this fact; lets a non-stale topic be retired. */
    readonly supersededBy?: string;
}

export type DreamAction = DreamMergeAction | DreamRewriteAction | DreamArchiveAction;

/** Per-run knobs; also the job args the Schedules UI edits. */
export interface DreamOptions {
    /** Min hours since the last consolidation before a scheduled run acts. */
    readonly minHours: number;
    /** Min topics added or updated since the last consolidation. */
    readonly minChanges: number;
    /** Topics untouched (written or read) this long become archive candidates. */
    readonly staleDays: number;
    /** Longer horizon for user / feedback topics, which age more slowly. */
    readonly staleDaysDurable: number;
}

export const DEFAULT_DREAM_OPTIONS: DreamOptions = {
    minHours: 24,
    minChanges: 5,
    staleDays: 90,
    staleDaysDurable: 180,
};

/** Upper bound on the share of topics one plan may archive (merge sources included). */
export const MAX_ARCHIVE_RATIO = 0.3;

/** A topic as the model sees it, with the signals the prompt reasons over. */
export interface DreamTopicView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly type: MemoryEntryType;
    readonly content: string;
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly lastReadAt?: string;
    /** Days since the latest of created / updated / read. */
    readonly idleDays: number;
    /** True when idleDays passed the staleness horizon for its type. */
    readonly stale: boolean;
}

// ─── topic views ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Latest activity across write and read time. */
export function lastActivityAt(topic: MemoryEntry, lastReadAt: string | undefined): number {
    const stamps = [topic.createdAt, topic.updatedAt, lastReadAt]
        .filter((at): at is string => typeof at === "string")
        .map((at) => Date.parse(at))
        .filter((ms) => Number.isFinite(ms));
    return stamps.length > 0 ? Math.max(...stamps) : 0;
}

export function buildTopicViews(
    topics: readonly MemoryEntry[],
    usage: Readonly<Record<string, string>>,
    options: DreamOptions,
    now: number,
): DreamTopicView[] {
    return topics.map((topic) => {
        const lastReadAt = usage[topic.id];
        const idleDays = Math.max(
            0,
            Math.floor((now - lastActivityAt(topic, lastReadAt)) / DAY_MS),
        );
        const horizon =
            topic.type === "user" || topic.type === "feedback"
                ? options.staleDaysDurable
                : options.staleDays;
        return {
            id: topic.id,
            name: topic.name,
            description: topic.description,
            type: topic.type,
            content: topic.content,
            createdAt: topic.createdAt,
            updatedAt: topic.updatedAt,
            lastReadAt,
            idleDays,
            stale: idleDays >= horizon,
        };
    });
}

// ─── parsing ──────────────────────────────────────────────────────────────────

const asText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Parse the model's JSON into actions. Malformed items are dropped here;
 * semantic checks (ids exist, no overlaps) happen in `validateDreamPlan`.
 */
export function parseDreamActions(raw: string): DreamAction[] | null {
    // The prompt asks for `{"actions": [...]}`; a bare array is accepted too.
    const parsed = extractJsonSpan(raw, "{}");
    if (Array.isArray(parsed)) return parseActionList(parsed);
    const actions = (parsed as { actions?: unknown } | null)?.actions;
    if (Array.isArray(actions)) return parseActionList(actions);
    const bare = extractJsonSpan(raw, "[]");
    return Array.isArray(bare) ? parseActionList(bare) : null;
}

function parseActionList(list: readonly unknown[]): DreamAction[] {
    const actions: DreamAction[] = [];
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const id = asText(raw.id);
        switch (raw.action) {
            case "merge": {
                const sourceIds = Array.isArray(raw.sourceIds)
                    ? raw.sourceIds.map(asText).filter((v): v is string => v !== undefined)
                    : [];
                const name = asText(raw.name);
                const content = asText(raw.content);
                const type = asText(raw.type);
                if (!id || !name || !content || !type) continue;
                if (!(MEMORY_ENTRY_TYPES as readonly string[]).includes(type)) continue;
                actions.push({
                    action: "merge",
                    sourceIds,
                    id: normalizeMemoryTopicId(id),
                    name: name.slice(0, 60),
                    description: (asText(raw.description) ?? name).slice(0, 120),
                    type: type as MemoryEntryType,
                    content: content.slice(0, MEMORY_CONTENT_MAX_CHARS),
                });
                break;
            }
            case "rewrite": {
                const content = asText(raw.content);
                if (!id || !content) continue;
                actions.push({
                    action: "rewrite",
                    id,
                    content: content.slice(0, MEMORY_CONTENT_MAX_CHARS),
                });
                break;
            }
            case "archive": {
                const reason = asText(raw.reason);
                if (!id || !reason) continue;
                const supersededBy = asText(raw.supersededBy);
                actions.push({
                    action: "archive",
                    id,
                    reason: reason.slice(0, 200),
                    ...(supersededBy ? { supersededBy } : {}),
                });
                break;
            }
            default:
                break;
        }
    }
    return actions;
}

// ─── validation ───────────────────────────────────────────────────────────────

export type DreamPlanCheck = { ok: true } | { ok: false; reason: string };

/**
 * Reject the whole plan unless every action is consistent with the topics the
 * model was shown. Kept mechanical on purpose: these are the guarantees that
 * hold no matter what the model believed.
 */
export function validateDreamPlan(
    actions: readonly DreamAction[],
    views: readonly DreamTopicView[],
): DreamPlanCheck {
    const byId = new Map(views.map((view) => [view.id, view]));
    const touched = new Set<string>();
    const claim = (id: string): DreamPlanCheck => {
        if (touched.has(id)) return { ok: false, reason: `topic ${id} appears in two actions` };
        touched.add(id);
        return { ok: true };
    };

    let archived = 0;
    const mergeTargets = new Set<string>();
    const allMergeTargets = new Set(
        actions.filter((a) => a.action === "merge").map((a) => (a as DreamMergeAction).id),
    );
    for (const action of actions) {
        if (action.action === "merge") {
            if (action.sourceIds.length < 2) {
                return { ok: false, reason: `merge into ${action.id} needs at least two sources` };
            }
            for (const sourceId of action.sourceIds) {
                if (!byId.has(sourceId)) {
                    return { ok: false, reason: `merge source ${sourceId} does not exist` };
                }
                const check = claim(sourceId);
                if (!check.ok) return check;
                archived++;
            }
            if (!action.id) return { ok: false, reason: "merge target id is empty" };
            // Always a fresh id, never a source's: the sources move to
            // archive/ under their own ids, and undo must tell the merged
            // topic and its sources apart.
            if (byId.has(action.id)) {
                return { ok: false, reason: `merge target ${action.id} reuses an existing id` };
            }
            if (mergeTargets.has(action.id)) {
                return { ok: false, reason: `two merges target ${action.id}` };
            }
            mergeTargets.add(action.id);
        } else if (action.action === "rewrite") {
            if (!byId.has(action.id)) {
                return { ok: false, reason: `rewrite target ${action.id} does not exist` };
            }
            const check = claim(action.id);
            if (!check.ok) return check;
        } else {
            const view = byId.get(action.id);
            if (!view) return { ok: false, reason: `archive target ${action.id} does not exist` };
            const check = claim(action.id);
            if (!check.ok) return check;
            archived++;
            // Only stale topics may be retired on the model's judgement alone;
            // a recently active one needs a surviving topic that holds its fact.
            if (!view.stale) {
                if (!action.supersededBy) {
                    return {
                        ok: false,
                        reason: `archive of active topic ${action.id} needs supersededBy`,
                    };
                }
                const survivor = action.supersededBy;
                const survives =
                    allMergeTargets.has(survivor) ||
                    (byId.has(survivor) && !isRetired(survivor, actions));
                if (!survives) {
                    return {
                        ok: false,
                        reason: `archive of ${action.id} points at ${survivor}, which does not survive`,
                    };
                }
            }
        }
    }

    const cap = Math.floor(views.length * MAX_ARCHIVE_RATIO);
    if (archived > cap) {
        return {
            ok: false,
            reason: `plan retires ${archived} of ${views.length} topics (cap ${cap})`,
        };
    }
    return { ok: true };
}

/** Whether a plan archives `id` directly or as a merge source. */
function isRetired(id: string, actions: readonly DreamAction[]): boolean {
    return actions.some(
        (a) =>
            (a.action === "archive" && a.id === id) ||
            (a.action === "merge" && a.sourceIds.includes(id)),
    );
}

// ─── summary ──────────────────────────────────────────────────────────────────

export interface DreamPlanCounts {
    readonly merged: number;
    readonly mergedInto: number;
    readonly rewritten: number;
    readonly archived: number;
}

export function countDreamActions(actions: readonly DreamAction[]): DreamPlanCounts {
    let merged = 0;
    let mergedInto = 0;
    let rewritten = 0;
    let archived = 0;
    for (const action of actions) {
        if (action.action === "merge") {
            merged += action.sourceIds.length;
            mergedInto++;
        } else if (action.action === "rewrite") {
            rewritten++;
        } else {
            archived++;
        }
    }
    return { merged, mergedInto, rewritten, archived };
}
