/**
 * Persisted per-workspace session metadata index.
 *
 * `SessionRegistry.hydrateSessionMetadata` fills the name/facts/activity/
 * message-count caches by streaming every line of a session's JSONL file.
 * Those caches are in-memory only, so a cold daemon pays one full scan per
 * session on the first `session.list` — with a few hundred sessions that is
 * the bulk of the desktop's cold-start wait, and it is proportional to the
 * total bytes on disk, not the page the client asked for.
 *
 * This module persists the scan results to one small JSON file per
 * workspace. An entry is trusted only when its recorded `modifiedAt` equals
 * the session file's current mtime (which `repo.list` already stats): every
 * mutation path — message append, rename, facts write — bumps mtime, and a
 * delete removes the file, so a match cannot serve stale data and a
 * mismatch simply falls back to rescanning that one file.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionId } from "@taco-ai/protocol";
import { createLogger } from "../../lib/logger.ts";
import type { SessionFacts } from "./sessionFacts.ts";
import type { TitleSource } from "./sessionTitleSource.ts";

const log = createLogger("sidecar.sessionMetadataIndex");

/** Bump when the entry shape changes; a mismatched file is ignored, not migrated. */
const INDEX_VERSION = 1;

export interface PersistedSessionMetadata {
    name: string | undefined;
    facts: SessionFacts;
    activityAt: number | undefined;
    titleSource: TitleSource | undefined;
    messageCount: number;
    /**
     * Session file mtime (ms) captured before the scan started. It can never
     * be newer than the scanned content, so a later mutation always produces
     * a mismatch — the safe (rescan) direction.
     */
    modifiedAt: number;
}

interface IndexFile {
    version: number;
    entries: Record<string, PersistedSessionMetadata>;
}

/**
 * `<sessionsRoot>/.taco-metadata-index/<hash>.json`, one file per workspace
 * cwd. sessionsRoot is shared across workspaces (IM channels get their own
 * root), so the per-cwd hash keeps files apart. The hidden directory name
 * cannot collide with pi's `--cwd--` session dirs or taco's `<sid>`
 * attachment dirs, and pi's repo.list only reads `*.jsonl` inside its own
 * per-cwd directory, so the index is invisible to it.
 */
export function sessionMetadataIndexPath(sessionsRoot: string, cwd: string): string {
    const key = createHash("sha256").update(cwd).digest("hex").slice(0, 32);
    return join(sessionsRoot, ".taco-metadata-index", `${key}.json`);
}

function isValidEntry(raw: unknown): raw is PersistedSessionMetadata {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    return (
        typeof entry.modifiedAt === "number" &&
        Number.isFinite(entry.modifiedAt) &&
        typeof entry.messageCount === "number" &&
        (entry.facts === null || typeof entry.facts === "object") &&
        (entry.name === undefined || typeof entry.name === "string") &&
        (entry.activityAt === undefined || typeof entry.activityAt === "number")
    );
}

/** Read the index; any problem (missing, corrupted, version drift) yields an empty map. */
export async function loadSessionMetadataIndex(
    path: string,
): Promise<Map<SessionId, PersistedSessionMetadata>> {
    const map = new Map<SessionId, PersistedSessionMetadata>();
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        return map; // First run, or the file was cleaned up — both rescan.
    }
    try {
        const parsed = JSON.parse(raw) as IndexFile;
        if (parsed.version !== INDEX_VERSION || typeof parsed.entries !== "object") return map;
        for (const [id, entry] of Object.entries(parsed.entries)) {
            if (isValidEntry(entry)) map.set(id as SessionId, entry);
        }
    } catch (err) {
        // A torn write should be impossible (atomic rename below); log so a
        // real format regression is diagnosable instead of silently slow.
        log.warn("ignoring unreadable session metadata index", path, err);
    }
    return map;
}

/**
 * Write the index atomically (tmp + rename) so a crash mid-write never leaves
 * a half file that the next cold start would have to ignore. `keepIds`, when
 * given, prunes entries for sessions no longer on disk (deletes never rewrite
 * the file, so mtime validation alone cannot drop them).
 */
export async function saveSessionMetadataIndex(
    path: string,
    entries: ReadonlyMap<SessionId, PersistedSessionMetadata>,
    keepIds?: ReadonlySet<string>,
): Promise<void> {
    const out: Record<string, PersistedSessionMetadata> = {};
    for (const [id, entry] of entries) {
        if (keepIds && !keepIds.has(id)) continue;
        out[id] = entry;
    }
    const doc: IndexFile = { version: INDEX_VERSION, entries: out };
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(doc), "utf8");
    await rename(tmp, path);
}
