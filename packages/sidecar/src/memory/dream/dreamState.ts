/**
 * Per-workspace dream state, kept in `<topicDir>/.dream/` beside the topics.
 *
 *   .dream/lock          — holder pid while a run is in progress; absent otherwise
 *   .dream/last-run      — its mtime IS the last consolidation time
 *   .dream/state.json    — first-plan confirmation and failure backoff
 *   .dream/pending.json  — a preview plan awaiting apply / discard
 *   .dream/reports/*.json — before/after record of each applied plan (undo)
 *   .dream/usage.json    — last time each topic file was opened by `read`
 *
 * Every file sits under the topic dir, so `readProjectTopics` (top-level
 * `*.md` only) never mistakes any of it for a topic. All writes are atomic.
 *
 * The lock is created exclusively (`wx`), so two processes cannot both hold
 * it; a holder that died or has held it past HOLDER_STALE_MS is reclaimed.
 * The run time is stamped when a successful run releases the lock, not when
 * it starts, so the topics the run itself wrote do not count as churn for
 * the next gate. A failed run leaves the stamp alone and records a backoff.
 */

import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DREAM_DIR = ".dream";
const LOCK_FILE = "lock";
const LAST_RUN_FILE = "last-run";
const STATE_FILE = "state.json";
const PENDING_FILE = "pending.json";
const USAGE_FILE = "usage.json";
const REPORTS_DIR = "reports";

/** A lock held longer than this is stale even if its pid is alive (pid reuse). */
export const HOLDER_STALE_MS = 60 * 60 * 1000;

/** A lock with no pid written yet, older than this, is a crashed acquire. */
const EMPTY_HOLDER_GRACE_MS = 10_000;

// ─── helpers ──────────────────────────────────────────────────────────────────

function dreamDir(topicDir: string): string {
    return join(topicDir, DREAM_DIR);
}

function atomicWriteJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        renameSync(tmp, path);
    } catch (error) {
        try {
            unlinkSync(tmp);
        } catch {
            // ignore cleanup failure
        }
        throw error;
    }
}

function readJson<T>(path: string): T | undefined {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return undefined;
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the pid exists but belongs to someone else — still a live holder.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Topic dirs this process holds. The lock file names the holder pid, and the
 * scheduled job and a manual UI run share one daemon process, so the pid
 * alone cannot tell this process's two callers apart.
 */
const heldHere = new Set<string>();

/** The pid the lock file names, or undefined when unreadable / cleared. */
function readHolder(path: string): number | undefined {
    try {
        const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
        return Number.isFinite(holder) && holder > 0 ? holder : undefined;
    } catch {
        return undefined;
    }
}

function lockPath(topicDir: string): string {
    return join(dreamDir(topicDir), LOCK_FILE);
}

/** Whether the lock file is one nobody will release: dead holder, or too old. */
function isAbandoned(path: string, now: number): boolean {
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return false;
    }
    const holder = readHolder(path);
    // No pid yet: either a holder between create and write (a few ms), or one
    // that crashed in that gap. A short grace tells the two apart.
    if (holder === undefined) return now - mtimeMs >= EMPTY_HOLDER_GRACE_MS;
    if (holder !== process.pid && !isPidAlive(holder)) return true;
    return now - mtimeMs >= HOLDER_STALE_MS;
}

// ─── lock / last-run time ─────────────────────────────────────────────────────

/**
 * Last successful consolidation time in ms, or 0 when never consolidated.
 *
 * Workspaces consolidated before `last-run` existed kept that time as the
 * lock file's mtime, with an empty body once released. Read it as the run
 * time until the next successful run writes `last-run`; otherwise every such
 * workspace would look never-consolidated and skip the time gate.
 */
export function readLastDreamAt(topicDir: string): number {
    try {
        return statSync(join(dreamDir(topicDir), LAST_RUN_FILE)).mtimeMs;
    } catch {
        // fall through to the legacy stamp
    }
    const lock = lockPath(topicDir);
    try {
        if (readHolder(lock) !== undefined) return 0;
        return statSync(lock).mtimeMs;
    } catch {
        return 0;
    }
}

/** Whether a run currently holds this workspace's lock. */
export function isDreamLocked(topicDir: string, now = Date.now()): boolean {
    const path = lockPath(topicDir);
    if (heldHere.has(path)) return true;
    return existsSync(path) && !isAbandoned(path, now);
}

/**
 * Take the workspace lock. Returns true on success, false when another run
 * holds it. The create is exclusive, so of two racing processes exactly one
 * wins; an abandoned lock is removed and the create retried once.
 */
export function tryAcquireDreamLock(topicDir: string, now = Date.now()): boolean {
    const path = lockPath(topicDir);
    if (heldHere.has(path)) return false;
    mkdirSync(dreamDir(topicDir), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(path, String(process.pid), { encoding: "utf8", flag: "wx" });
            heldHere.add(path);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (attempt > 0 || !isAbandoned(path, now)) return false;
            try {
                unlinkSync(path);
            } catch {
                // Another reclaimer removed it first; the retry decides.
            }
        }
    }
    return false;
}

/** Drop the lock, but only one this process still holds. */
function dropLock(topicDir: string): void {
    const path = lockPath(topicDir);
    const held = heldHere.delete(path);
    // A reclaimed lock now names another holder: removing it would let a
    // third run in beside that one.
    if (!held || readHolder(path) !== process.pid) return;
    try {
        unlinkSync(path);
    } catch {
        // already gone
    }
}

/** Release after success: stamp the run time and drop the lock. */
export function releaseDreamLock(topicDir: string, now = new Date()): void {
    const stamp = join(dreamDir(topicDir), LAST_RUN_FILE);
    try {
        mkdirSync(dreamDir(topicDir), { recursive: true });
        writeFileSync(stamp, "", "utf8");
        utimesSync(stamp, now, now);
    } catch {
        // A missing stamp only lets the next scheduled run come early.
    }
    dropLock(topicDir);
}

/** Release after failure: the run time stays as it was. */
export function rollbackDreamLock(topicDir: string): void {
    dropLock(topicDir);
}

// ─── confirmation state ───────────────────────────────────────────────────────

interface DreamWorkspaceState {
    /** Set once the user applied a preview; scheduled runs then apply directly. */
    confirmedAt?: string;
    /** Scheduled runs that failed in a row since the last success. */
    failures?: number;
    /** Last failed scheduled run (ISO). */
    lastFailureAt?: string;
}

/** Backoff after the first failure; doubles per failure up to the cap. */
const FAILURE_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function readState(topicDir: string): DreamWorkspaceState {
    const state = readJson<DreamWorkspaceState>(join(dreamDir(topicDir), STATE_FILE));
    return state && typeof state === "object" ? state : {};
}

function writeState(topicDir: string, state: DreamWorkspaceState): void {
    atomicWriteJson(join(dreamDir(topicDir), STATE_FILE), state);
}

export function readDreamConfirmed(topicDir: string): boolean {
    return typeof readState(topicDir).confirmedAt === "string";
}

export function markDreamConfirmed(topicDir: string, now = new Date()): void {
    writeState(topicDir, { ...readState(topicDir), confirmedAt: now.toISOString() });
}

/** Record a failed scheduled run, so the next ones back off. */
export function recordDreamFailure(topicDir: string, now = new Date()): void {
    const state = readState(topicDir);
    writeState(topicDir, {
        ...state,
        failures: (state.failures ?? 0) + 1,
        lastFailureAt: now.toISOString(),
    });
}

/** Clear the failure streak after a run that reached the model and back. */
export function clearDreamFailures(topicDir: string): void {
    const state = readState(topicDir);
    if (state.failures === undefined && state.lastFailureAt === undefined) return;
    const { failures: _f, lastFailureAt: _l, ...rest } = state;
    writeState(topicDir, rest);
}

/**
 * When a workspace that keeps failing may be tried again, in ms; 0 when it
 * is not backing off. Without this a failing workspace never stamps a run
 * time, sorts first on every fire, and takes a slot from the others.
 */
export function dreamRetryAt(topicDir: string): number {
    const state = readState(topicDir);
    const failures = state.failures ?? 0;
    const at = state.lastFailureAt ? Date.parse(state.lastFailureAt) : Number.NaN;
    if (failures === 0 || !Number.isFinite(at)) return 0;
    const delay = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1), FAILURE_BACKOFF_MAX_MS);
    return at + delay;
}

// ─── pending preview ──────────────────────────────────────────────────────────

export function readPendingPlan<T>(topicDir: string): T | undefined {
    return readJson<T>(join(dreamDir(topicDir), PENDING_FILE));
}

export function writePendingPlan(topicDir: string, plan: unknown): void {
    atomicWriteJson(join(dreamDir(topicDir), PENDING_FILE), plan);
}

export function clearPendingPlan(topicDir: string): void {
    try {
        unlinkSync(join(dreamDir(topicDir), PENDING_FILE));
    } catch {
        // already gone
    }
}

// ─── reports ──────────────────────────────────────────────────────────────────

/** Reports kept on disk per workspace; older ones are pruned on write. */
export const KEPT_DREAM_REPORTS = 20;

/** Persist an applied plan's before/after record under its own id. */
export function writeDreamReport<T extends { readonly id: string }>(
    topicDir: string,
    report: T,
): void {
    atomicWriteJson(join(dreamDir(topicDir), REPORTS_DIR, `${report.id}.json`), report);
    for (const stale of listDreamReportIds(topicDir).slice(KEPT_DREAM_REPORTS)) {
        try {
            unlinkSync(join(dreamDir(topicDir), REPORTS_DIR, `${stale}.json`));
        } catch {
            // already gone
        }
    }
}

export function readDreamReport<T>(topicDir: string, id: string): T | undefined {
    // Report ids are generated timestamps; refuse anything that could escape the dir.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    return readJson<T>(join(dreamDir(topicDir), REPORTS_DIR, `${id}.json`));
}

/** Report ids, newest first (ids sort chronologically). */
export function listDreamReportIds(topicDir: string): string[] {
    try {
        return readdirSync(join(dreamDir(topicDir), REPORTS_DIR))
            .filter((file) => file.endsWith(".json"))
            .map((file) => file.slice(0, -".json".length))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

// ─── usage ────────────────────────────────────────────────────────────────────

type UsageMap = Record<string, string>;

/** Last `read` time per topic id (ISO). Missing ids were never opened. */
export function readTopicUsage(topicDir: string): UsageMap {
    const usage = readJson<UsageMap>(join(dreamDir(topicDir), USAGE_FILE));
    return usage && typeof usage === "object" ? usage : {};
}

/** Merge read times into the usage file, keeping the later time per id. */
export function recordTopicUsage(topicDir: string, reads: UsageMap): void {
    const merged = readTopicUsage(topicDir);
    for (const [id, at] of Object.entries(reads)) {
        const current = merged[id];
        if (current === undefined || current < at) merged[id] = at;
    }
    atomicWriteJson(join(dreamDir(topicDir), USAGE_FILE), merged);
}

/** Drop usage entries for ids that are no longer live topics. */
export function pruneTopicUsage(topicDir: string, liveIds: ReadonlySet<string>): void {
    const usage = readTopicUsage(topicDir);
    const kept: UsageMap = {};
    let dropped = 0;
    for (const [id, at] of Object.entries(usage)) {
        if (liveIds.has(id)) kept[id] = at;
        else dropped++;
    }
    if (dropped > 0) atomicWriteJson(join(dreamDir(topicDir), USAGE_FILE), kept);
}
