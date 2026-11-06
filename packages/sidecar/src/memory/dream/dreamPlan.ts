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
 * The model never writes files. It submits a structured plan; `validateDreamPlan` rejects
 * the whole plan on any inconsistency, so a half-understood plan cannot be
 * partially applied.
 */

import { type MemoryEntry, type MemoryEntryType, normalizeMemoryTopicId } from "../types.ts";

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
    readonly name?: string;
    readonly description?: string;
}

export interface DreamArchiveAction {
    readonly action: "archive";
    readonly id: string;
    readonly reason: string;
    /** A kept topic that now holds this fact; lets a non-stale topic be retired. */
    readonly supersededBy?: string;
    readonly category?: DreamArchiveCategory;
    readonly evidence?: string;
}

export const DREAM_ARCHIVE_CATEGORIES = [
    "duplicate",
    "superseded",
    "transient",
    "non_durable",
    "invalidated",
    "stale",
] as const;
export type DreamArchiveCategory = (typeof DREAM_ARCHIVE_CATEGORIES)[number];

export type DreamAction = DreamMergeAction | DreamRewriteAction | DreamArchiveAction;

/** Per-run knobs; also the job args the Schedules UI edits. */
export interface DreamOptions {
    /** Min hours since the last consolidation before a scheduled run acts. */
    readonly minHours: number;
    /** Topics untouched (written or read) this long become archive candidates. */
    readonly staleDays: number;
    /** Longer horizon for user / feedback topics, which age more slowly. */
    readonly staleDaysDurable: number;
    readonly archiveCleanupEnabled?: boolean;
    readonly archiveRetentionDays?: 7 | 30 | 90;
}

export const DEFAULT_DREAM_OPTIONS: DreamOptions = {
    minHours: 24,
    staleDays: 90,
    staleDaysDurable: 180,
    archiveCleanupEnabled: false,
    archiveRetentionDays: 7,
};

/** Upper bound on the share of topics one plan may archive (merge sources included). */
export const MAX_ARCHIVE_RATIO = 0.3;

/** How many topics one plan may retire. The floor keeps one binary merge possible. */
export function retirementCap(topicCount: number): number {
    return Math.max(2, Math.floor(topicCount * MAX_ARCHIVE_RATIO));
}

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
    readonly explicitlyRequested?: boolean;
    readonly sources?: MemoryEntry["sources"];
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
            ...((topic as MemoryEntry & { explicitlyRequested?: boolean }).explicitlyRequested ===
            undefined
                ? {}
                : {
                      explicitlyRequested: (
                          topic as MemoryEntry & { explicitlyRequested?: boolean }
                      ).explicitlyRequested,
                  }),
            ...(topic.sources?.length ? { sources: topic.sources } : {}),
        };
    });
}

/** Actions one run may submit; the prompt and tool schema share this limit. */
export const MAX_DREAM_ACTIONS = 40;

/**
 * Point a plan's ids at the topics they name.
 *
 * The model is shown the ids as they sit on disk, and older topics keep the
 * underscores they were written with (`user_role_zh`). Resolve references
 * against the shown topics: an exact match first, then a unique normalized one.
 */
export function resolveActionIds(
    actions: readonly DreamAction[],
    views: readonly DreamTopicView[],
): DreamAction[] {
    const exact = new Set(views.map((view) => view.id));
    const normalized = new Map<string, string[]>();
    for (const view of views) {
        const key = normalizeMemoryTopicId(view.id);
        const bucket = normalized.get(key);
        if (bucket) bucket.push(view.id);
        else normalized.set(key, [view.id]);
    }
    const resolve = (id: string): string => {
        if (exact.has(id)) return id;
        const bucket = normalized.get(normalizeMemoryTopicId(id));
        // An ambiguous key names two topics: leave the id alone and let the
        // validator reject it rather than guess which one was meant.
        return bucket && bucket.length === 1 ? bucket[0] : id;
    };
    // A merge target names the topic to create, so it keeps its own id: mapping
    // it onto an existing topic would turn a runnable plan into a rejected one.
    const mergeTargets = new Set(
        actions.filter((action) => action.action === "merge").map((action) => action.id),
    );
    return actions.map((action) => {
        if (action.action === "merge") {
            return { ...action, sourceIds: action.sourceIds.map(resolve) };
        }
        if (action.action === "rewrite") {
            return { ...action, id: resolve(action.id) };
        }
        const supersededBy = action.supersededBy;
        return {
            ...action,
            id: resolve(action.id),
            ...(supersededBy === undefined || mergeTargets.has(supersededBy)
                ? {}
                : { supersededBy: resolve(supersededBy) }),
        };
    });
}

/**
 * The topics an action touches: the ones it consumes, rewrites or archives.
 */
function touchedTopics(action: DreamAction): readonly string[] {
    if (action.action === "merge") return action.sourceIds;
    return [action.id];
}

/**
 * Drop actions that touch a topic an earlier action already claimed.
 *
 * One topic in two actions is a model slip, and the rest of the plan still
 * removes real duplication — rejecting the whole plan for it throws that
 * away, the same way the retirement cap used to. Keep the earlier action:
 * the prompt asks for the most valuable actions first.
 */
export function trimConflictingActions(actions: readonly DreamAction[]): {
    actions: DreamAction[];
    dropped: number;
} {
    const claimed = new Set<string>();
    const kept: DreamAction[] = [];
    let dropped = 0;
    for (const action of actions) {
        if (touchedTopics(action).some((id) => claimed.has(id))) {
            dropped++;
            continue;
        }
        for (const id of touchedTopics(action)) claimed.add(id);
        kept.push(action);
    }

    // An archive may appear before the merge it references. Once the conflict
    // pass has decided which merges survived, remove every archive whose
    // supersededBy points at a merge target that was dropped.
    const allMergeTargets = new Set(
        actions.filter((action) => action.action === "merge").map((action) => action.id),
    );
    const keptMergeTargets = new Set(
        kept.filter((action) => action.action === "merge").map((action) => action.id),
    );
    const dependencyFree = kept.filter((action) => {
        if (
            action.action === "archive" &&
            action.supersededBy !== undefined &&
            allMergeTargets.has(action.supersededBy) &&
            !keptMergeTargets.has(action.supersededBy)
        ) {
            dropped++;
            return false;
        }
        return true;
    });
    return { actions: dependencyFree, dropped };
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
            const entry = view;
            const category = action.category;
            const survivor = action.supersededBy;
            const requiresSurvivor = category === "duplicate" || category === "superseded";
            if (requiresSurvivor && !survivor) {
                return { ok: false, reason: `archive category ${category} needs supersededBy` };
            }
            if (category === "invalidated") {
                if (!action.evidence)
                    return { ok: false, reason: "invalidated archive needs evidence" };
                const survivorText = survivor ? byId.get(survivor)?.content : undefined;
                if (action.evidence !== view.content && action.evidence !== survivorText) {
                    return { ok: false, reason: "invalidated evidence must quote an input memory" };
                }
            }
            const knownAutomatic =
                entry.sources?.some(
                    (source) =>
                        (source.via === "auto" && source.explicitlyRequested !== true) ||
                        (source.via === "tool" && source.explicitlyRequested === false),
                ) ?? false;
            const lowUsefulness =
                category === "transient" || category === "non_durable" || category === "stale";
            if (
                lowUsefulness &&
                (entry.explicitlyRequested === true ||
                    entry.sources?.some((source) => source.explicitlyRequested === true) === true)
            ) {
                return {
                    ok: false,
                    reason: "explicitly requested topic is protected from low-usefulness retirement",
                };
            }
            if ((category === "transient" || category === "non_durable") && !knownAutomatic) {
                return {
                    ok: false,
                    reason: `${category} retirement needs a known automatic origin`,
                };
            }
            const knownLowUsefulnessOrigin =
                (category === "transient" || category === "non_durable") && knownAutomatic;
            // Only stale topics may be retired on the model's judgement alone;
            // a recently active one needs a surviving topic that holds its fact.
            if (!view.stale && !knownLowUsefulnessOrigin) {
                if (!action.supersededBy) {
                    return {
                        ok: false,
                        reason: `archive of active topic ${action.id} needs supersededBy`,
                    };
                }
                const survives =
                    survivor !== undefined &&
                    (allMergeTargets.has(survivor) ||
                        (byId.has(survivor) && !isRetired(survivor, actions)));
                if (!survives) {
                    return {
                        ok: false,
                        reason: `archive of ${action.id} points at ${survivor}, which does not survive`,
                    };
                }
            }
        }
    }

    // The floor keeps one binary merge possible on a small set: floor(n * 0.3)
    // is 0 or 1 for n < 7, which would reject every merge — the one action
    // that removes duplication. A merge also carries its facts forward, so
    // the floor does not weaken what the ratio protects against.
    const cap = retirementCap(views.length);
    if (archived > cap) {
        return {
            ok: false,
            reason: `plan retires ${archived} of ${views.length} topics (cap ${cap})`,
        };
    }
    return { ok: true };
}

/**
 * Bring a plan under the retirement cap by dropping later actions.
 *
 * Rejecting the whole plan for this one overreach throws away every valid
 * merge, rewrite and archive it also proposed — and a workspace large enough
 * to hit the cap would fail that way on every scheduled run. Archives go
 * first: a stale topic can wait for the next run, and merges carry their
 * sources' facts forward. Only if archives alone cannot make room are merges
 * dropped, from the end of the plan.
 *
 * Retirement counts are computed as `validateDreamPlan` counts them, so the
 * trimmed plan is guaranteed to pass that check.
 */
export function capRetirement(
    actions: readonly DreamAction[],
    views: readonly DreamTopicView[],
): { readonly actions: readonly DreamAction[]; readonly dropped: number } {
    const cap = retirementCap(views.length);
    const retired = actions.reduce((sum, action) => {
        if (action.action === "merge") return sum + action.sourceIds.length;
        return sum + (action.action === "archive" ? 1 : 0);
    }, 0);
    if (retired <= cap) return { actions, dropped: 0 };

    let remaining = retired;
    let dropped = 0;
    const kept = [...actions];
    for (let i = kept.length - 1; i >= 0 && remaining > cap; i--) {
        if (kept[i]?.action !== "archive") continue;
        remaining--;
        dropped++;
        kept.splice(i, 1);
    }
    for (let i = kept.length - 1; i >= 0 && remaining > cap; i--) {
        const action = kept[i];
        if (action?.action !== "merge") continue;
        remaining -= action.sourceIds.length;
        dropped++;
        kept.splice(i, 1);
    }
    return { actions: kept, dropped };
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
