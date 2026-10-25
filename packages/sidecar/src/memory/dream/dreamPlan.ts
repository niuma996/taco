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

/** Action kinds the model may name in any of several fields. */
type ActionKind = "merge" | "rewrite" | "archive";

const KIND_BY_KEY: Record<string, ActionKind> = {
    merge: "merge",
    merges: "merge",
    rewrite: "rewrite",
    rewrites: "rewrite",
    archive: "archive",
    archives: "archive",
};

/** Keys whose array value is a list of actions. */
const ACTION_LIST_KEYS = ["actions", "plan", "items", "results", "changes"];

/** Actions one run may apply; the prompt states the same number. */
export const MAX_DREAM_ACTIONS = 40;

export interface ParsedDreamPlan {
    readonly actions: readonly DreamAction[];
    /** True when the reply named no action at all — a valid "nothing to do". */
    readonly empty: boolean;
    /** True when the JSON was incomplete and the actions came from salvage. */
    readonly recovered: boolean;
    /** Merges / rewrites dropped because their content is over the topic limit. */
    readonly oversized: number;
    /** Actions past MAX_DREAM_ACTIONS, dropped from the end. */
    readonly overCap: number;
}

/**
 * Parse the model's reply into actions. Malformed items are dropped; the
 * semantic checks (ids exist, no overlaps) live in `validateDreamPlan`.
 *
 * The shape is not fixed: models answer with `{"actions": [...]}`, a bare
 * array, or a per-kind object (`{"merges": [...], "archives": [...]}`), and
 * put the kind in `action`, `kind`, `op`, or `type`. All of those are
 * accepted, because rejecting a plan over its envelope loses a good
 * consolidation run.
 *
 * A reply that stops mid-JSON still yields its complete actions: the tail is
 * unfinished, but every closed object before it is a decision the model
 * finished making. `null` means neither a full parse nor a salvage produced
 * anything.
 */
export function parseDreamActions(raw: string): ParsedDreamPlan | null {
    const value = extractJsonSpan(raw, "{}") ?? extractJsonSpan(raw, "[]");
    const truncated = value === null || value === undefined;
    const candidates: ActionCandidate[] = truncated
        ? salvageActionObjects(raw).map((item) => ({ item }))
        : collectActionItems(value);
    if (truncated && candidates.length === 0) return null;

    const actions: DreamAction[] = [];
    let oversized = 0;
    for (const { kindHint, item } of candidates) {
        const action = parseActionItem(item, kindHint);
        if (action) actions.push(action);
        else if (isOversized(item)) oversized++;
    }
    return {
        // The prompt asks for the most valuable actions first, so the cap
        // keeps the head of the list.
        actions: actions.slice(0, MAX_DREAM_ACTIONS),
        empty: candidates.length === 0,
        recovered: truncated,
        oversized,
        overCap: Math.max(0, actions.length - MAX_DREAM_ACTIONS),
    };
}

/** Whether an unparsed item failed only because its content is over the limit. */
function isOversized(item: unknown): boolean {
    if (!item || typeof item !== "object") return false;
    const raw = item as Record<string, unknown>;
    const target = (raw.target ?? raw.merged ?? raw.result ?? raw) as Record<string, unknown>;
    const content = asText(target.content) ?? asText(raw.content);
    return content !== undefined && content.length > MEMORY_CONTENT_MAX_CHARS;
}

/**
 * Recover the whole action objects from a reply that stopped mid-JSON — a
 * truncated stream, or a model that quit while writing its last action. The
 * unfinished tail is ignored rather than guessed at, so every recovered
 * action is one the model actually committed to.
 */
function salvageActionObjects(raw: string): unknown[] {
    // Only a reply that names the actions array is salvageable. Starting from
    // an arbitrary "[" would pick up brackets from prose and scan objects
    // that were never part of a plan.
    const keyAt = raw.indexOf('"actions"');
    if (keyAt < 0) return [];
    const arrayAt = raw.indexOf("[", keyAt);
    if (arrayAt < 0) return [];

    const out: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = arrayAt + 1; i < raw.length; i++) {
        const char = raw[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === "{") {
            if (depth === 0) start = i;
            depth++;
        } else if (char === "}" && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                try {
                    out.push(JSON.parse(raw.slice(start, i + 1)));
                } catch {
                    // A broken object inside an otherwise usable plan.
                }
                start = -1;
            }
        }
    }
    return out;
}

interface ActionCandidate {
    /** Known from the enclosing key, when the item itself does not say. */
    readonly kindHint?: ActionKind;
    readonly item: unknown;
}

function collectActionItems(value: unknown): ActionCandidate[] {
    if (Array.isArray(value)) return value.map((item) => ({ item }));
    if (!value || typeof value !== "object") return [];
    const obj = value as Record<string, unknown>;
    const out: ActionCandidate[] = [];

    for (const key of ACTION_LIST_KEYS) {
        const list = obj[key];
        if (Array.isArray(list)) out.push(...list.map((item) => ({ item })));
    }
    for (const [key, kind] of Object.entries(KIND_BY_KEY)) {
        const list = obj[key];
        if (Array.isArray(list)) out.push(...list.map((item) => ({ kindHint: kind, item })));
    }
    // A single action object, e.g. {"action":"rewrite", ...}.
    if (out.length === 0 && (obj.action !== undefined || obj.kind !== undefined)) {
        out.push({ item: obj });
    }
    return out;
}

function parseActionItem(item: unknown, kindHint?: ActionKind): DreamAction | null {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const kind = resolveKind(raw, kindHint);
    if (!kind) return null;

    if (kind === "merge") return parseMerge(raw);
    if (kind === "rewrite") return parseRewrite(raw);
    return parseArchive(raw);
}

/** The kind can sit in `action`, `kind`, `op`, or `type`. */
function resolveKind(
    raw: Record<string, unknown>,
    kindHint: ActionKind | undefined,
): ActionKind | undefined {
    for (const field of ["action", "kind", "op", "type"]) {
        const value = asText(raw[field])?.toLowerCase();
        if (value === "merge" || value === "rewrite" || value === "archive") return value;
    }
    return kindHint;
}

function parseMerge(raw: Record<string, unknown>): DreamAction | null {
    const sourceIds = firstArray(raw, ["sourceIds", "source_ids", "sources", "from"]);
    if (sourceIds.length < 2) return null;
    // The merged topic may be inline or nested under `target` / `merged`.
    const target = (raw.target ?? raw.merged ?? raw.result ?? raw) as Record<string, unknown>;
    const id = asText(target.id);
    const name = asText(target.name);
    const content = asText(target.content);
    const type = asText(target.type);
    if (!id || !name || !content || !type) return null;
    if (!MEMORY_ENTRY_TYPES.includes(type as MemoryEntryType)) return null;
    // Over the limit is dropped, never cut: a cut merge would archive its
    // sources and keep only the start of what they said.
    if (content.length > MEMORY_CONTENT_MAX_CHARS) return null;
    return {
        action: "merge",
        sourceIds: sourceIds.map(normalizePlanId),
        id: normalizePlanId(id),
        name: name.slice(0, 60),
        description: (asText(target.description) ?? name).slice(0, 120),
        type: type as MemoryEntryType,
        content,
    };
}

function parseRewrite(raw: Record<string, unknown>): DreamAction | null {
    const id = asText(raw.id);
    const content = asText(raw.content);
    if (!id || !content) return null;
    // Same rule as a merge: a cut rewrite would replace the fact with a fragment.
    if (content.length > MEMORY_CONTENT_MAX_CHARS) return null;
    return { action: "rewrite", id: normalizePlanId(id), content };
}

function parseArchive(raw: Record<string, unknown>): DreamAction | null {
    const id = asText(raw.id);
    if (!id) return null;
    const supersededBy = asText(raw.supersededBy ?? raw.superseded_by ?? raw.replacedBy);
    return {
        action: "archive",
        id: normalizePlanId(id),
        // A missing reason is not worth dropping the action over.
        reason: (asText(raw.reason) ?? "retired by consolidation").slice(0, 200),
        ...(supersededBy ? { supersededBy: normalizePlanId(supersededBy) } : {}),
    };
}

/**
 * One normalisation for every id in a plan. Topic ids on disk are already
 * kebab-case, so this is the identity for a model that copied them; a model
 * that changed case or spacing still refers to the same topic, and a merge
 * target is matched against its own sources and supersededBy by the same rule.
 */
function normalizePlanId(id: string): string {
    return normalizeMemoryTopicId(id);
}

function firstArray(raw: Record<string, unknown>, keys: readonly string[]): string[] {
    for (const key of keys) {
        const list = raw[key];
        if (!Array.isArray(list)) continue;
        const ids = list.map(asText).filter((v): v is string => v !== undefined);
        if (ids.length > 0) return ids;
    }
    return [];
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
