/**
 * Per-workspace dream state, kept in `<topicDir>/.dream/` beside the topics.
 *
 *   .dream/lock          — holder pid; its mtime IS the last consolidation time
 *   .dream/state.json    — whether the user confirmed a first plan
 *   .dream/pending.json  — a preview plan awaiting apply / discard
 *   .dream/reports/*.json — before/after record of each applied plan (undo)
 *   .dream/usage.json    — last time each topic file was opened by `read`
 *
 * Every file sits under the topic dir, so `readProjectTopics` (top-level
 * `*.md` only) never mistakes any of it for a topic. All writes are atomic.
 *
 * The lock follows Claude Code's consolidation lock: acquiring it stamps the
 * mtime to now; a failed run rewinds the mtime so the time gate reopens; a
 * holder that died or has held it past HOLDER_STALE_MS is reclaimed.
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
const STATE_FILE = "state.json";
const PENDING_FILE = "pending.json";
const USAGE_FILE = "usage.json";
const REPORTS_DIR = "reports";

/** A lock held longer than this is stale even if its pid is alive (pid reuse). */
export const HOLDER_STALE_MS = 60 * 60 * 1000;

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

// ─── lock / last-run time ─────────────────────────────────────────────────────

/** Last consolidation time in ms (lock mtime), or 0 when never consolidated. */
export function readLastDreamAt(topicDir: string): number {
    try {
        return statSync(join(dreamDir(topicDir), LOCK_FILE)).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * Take the workspace lock. Returns the pre-acquire mtime for rollback, or
 * `null` when another live process holds it. Re-reads after writing so two
 * racing acquirers cannot both win: the loser sees the winner's pid.
 */
export function tryAcquireDreamLock(topicDir: string, now = Date.now()): number | null {
    const path = join(dreamDir(topicDir), LOCK_FILE);
    let priorMtime = 0;
    if (existsSync(path)) {
        try {
            priorMtime = statSync(path).mtimeMs;
            const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
            const held = Number.isFinite(holder) && holder > 0;
            // An empty body is a released lock: only its mtime matters.
            if (held && holder !== process.pid && isPidAlive(holder)) {
                if (now - priorMtime < HOLDER_STALE_MS) return null;
            }
        } catch {
            priorMtime = 0;
        }
    }
    mkdirSync(dreamDir(topicDir), { recursive: true });
    writeFileSync(path, String(process.pid), "utf8");
    try {
        if (Number.parseInt(readFileSync(path, "utf8").trim(), 10) !== process.pid) return null;
    } catch {
        return null;
    }
    return priorMtime;
}

/** Release after success: clear the holder; the mtime stays as the run time. */
export function releaseDreamLock(topicDir: string): void {
    const path = join(dreamDir(topicDir), LOCK_FILE);
    try {
        const mtime = statSync(path).mtime;
        writeFileSync(path, "", "utf8");
        utimesSync(path, mtime, mtime);
    } catch {
        // A missing lock already counts as released.
    }
}

/** Release after failure: rewind the mtime so the time gate passes again. */
export function rollbackDreamLock(topicDir: string, priorMtime: number): void {
    const path = join(dreamDir(topicDir), LOCK_FILE);
    try {
        if (priorMtime === 0) {
            unlinkSync(path);
            return;
        }
        writeFileSync(path, "", "utf8");
        const prior = new Date(priorMtime);
        utimesSync(path, prior, prior);
    } catch {
        // Best effort: a stuck mtime only delays the next run by one gate.
    }
}

// ─── confirmation state ───────────────────────────────────────────────────────

interface DreamWorkspaceState {
    /** Set once the user applied a preview; scheduled runs then apply directly. */
    confirmedAt?: string;
}

export function readDreamConfirmed(topicDir: string): boolean {
    const state = readJson<DreamWorkspaceState>(join(dreamDir(topicDir), STATE_FILE));
    return typeof state?.confirmedAt === "string";
}

export function markDreamConfirmed(topicDir: string, now = new Date()): void {
    atomicWriteJson(join(dreamDir(topicDir), STATE_FILE), {
        confirmedAt: now.toISOString(),
    } satisfies DreamWorkspaceState);
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

/** Persist an applied plan's before/after record under its own id. */
export function writeDreamReport<T extends { readonly id: string }>(
    topicDir: string,
    report: T,
): void {
    atomicWriteJson(join(dreamDir(topicDir), REPORTS_DIR, `${report.id}.json`), report);
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
