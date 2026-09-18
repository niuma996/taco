/**
 * Session title / facts / activity reader — scans a pi JSONL file on disk and
 * returns only the records this sidecar cares about, without materializing
 * pi's full storage index.
 *
 * Split out of `SessionRegistry` because it is a pure file-format adapter:
 * it reads pi's private v4 encoding and knows nothing about the registry's
 * caches, the attached map, or session lifecycle.
 */

import { createReadStream } from "node:fs";
import * as readline from "node:readline";
import { createLogger } from "../../lib/logger.ts";
import { SESSION_FACTS_NAMESPACE, type SessionFacts } from "./sessionFacts.ts";

const log = createLogger("sidecar.sessionMetadataReader");

/**
 * Namespace pi 0.85 writes `session.setName()` into. Before 0.85 the title was
 * a `{kind: "fact", fact: "name"}` entry; it is now a value record, so the
 * scanner below must match this namespace or every session reads as untitled.
 */
const SESSION_NAME_NAMESPACE = "pi.session.name";

/**
 * Parse the free-form `metadata` bag taco wrote onto pi v3 session headers
 * before 0.85 fixed the shape. Only structured fields we ourselves persisted
 * are accepted — unknown keys and wrong types are dropped, never guessed.
 */
export function parseLegacyV3TacoMetadata(metadata: unknown): SessionFacts {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        return {};
    }
    const bag = metadata as Record<string, unknown>;
    const facts: SessionFacts = {};
    if (bag.kind === "main" || bag.kind === "subagent") facts.kind = bag.kind;
    if (typeof bag.agentType === "string" && bag.agentType.length > 0) {
        facts.agentType = bag.agentType;
    }
    if (typeof bag.depth === "number" && Number.isSafeInteger(bag.depth) && bag.depth >= 0) {
        facts.depth = bag.depth;
    }
    if (typeof bag.parentSessionId === "string" && bag.parentSessionId.length > 0) {
        facts.parentSessionId = bag.parentSessionId;
    }
    if (typeof bag.parentToolCallId === "string" && bag.parentToolCallId.length > 0) {
        facts.parentToolCallId = bag.parentToolCallId;
    }
    if (typeof bag.forkedContext === "string" && bag.forkedContext.length > 0) {
        facts.forkedContext = bag.forkedContext;
    }
    return facts;
}

/**
 * First-line header of a session file, as far as taco needs it to classify
 * the session without opening (and thereby rewriting) the file.
 */
export type SessionFileHeader =
    | { format: "v4"; parentSessionId?: string }
    | { format: "v3"; facts: SessionFacts }
    | { format: "unknown" };

/**
 * Classify a session file from its first line only.
 *
 * `repo.list()` / the JSONL scanner never `open()` the file, so a v3 session
 * stays v3 until something else upgrades it. That is the only window in which
 * taco's pre-0.85 `metadata` bag is still on disk — pi's v3→v4 importer
 * drops it. Reading it here is what keeps those sessions off the user list
 * *before* anyone opens them.
 */
export function parseSessionFileHeader(line: string): SessionFileHeader {
    let header: unknown;
    try {
        header = JSON.parse(line);
    } catch {
        return { format: "unknown" };
    }
    if (header === null || typeof header !== "object" || Array.isArray(header)) {
        return { format: "unknown" };
    }
    const rec = header as Record<string, unknown>;
    if (rec.kind === "header" && rec.v === 4) {
        return {
            format: "v4",
            parentSessionId:
                typeof rec.parentSessionId === "string" && rec.parentSessionId.length > 0
                    ? rec.parentSessionId
                    : undefined,
        };
    }
    if (rec.type === "session" && rec.version === 3) {
        return { format: "v3", facts: parseLegacyV3TacoMetadata(rec.metadata) };
    }
    return { format: "unknown" };
}

/**
 * Read only the first line of a session file and, if it is still v3 with a
 * taco `metadata` bag, return those facts. Returns `undefined` for v4 files
 * (the bag is already gone) and for unreadable files (open must still proceed).
 *
 * Callers must invoke this *before* `repo.open()`: that call rewrites v3
 * storage in place and the bag is unrecoverable afterwards.
 */
export async function readLegacyFactsFromPath(path: string): Promise<SessionFacts | undefined> {
    const line = await readFirstLine(path);
    if (line === undefined) return undefined;
    const parsed = parseSessionFileHeader(line);
    if (parsed.format !== "v3") return undefined;
    if (parsed.facts.kind === undefined && parsed.facts.parentSessionId === undefined) {
        return undefined;
    }
    return parsed.facts;
}

async function readFirstLine(path: string): Promise<string | undefined> {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
        for await (const line of rl) return line;
        return undefined;
    } catch {
        return undefined;
    } finally {
        rl.close();
        if (!stream.destroyed) stream.destroy();
    }
}

/** One pi value record as it appears on disk, seen through the fields we read. */
interface ValueRecord {
    readonly kind?: string;
    readonly op?: string;
    readonly namespace?: string;
    readonly value?: unknown;
}

/**
 * Scan titles, facts, and last-message time without materializing pi's full
 * storage index for `session.list`. Read to EOF because renames and fact
 * updates append values; parse only matching records and retain only the
 * latest values. Last-message time is the activity clock the sidebar sorts
 * on — file mtime is not, because a v3→v4 rewrite (or a facts backfill)
 * updates mtime without a new user message.
 */
export async function readSessionMetadataFromDisk(path: string): Promise<{
    name: string | undefined;
    facts: SessionFacts;
    activityAt: number | undefined;
}> {
    // createReadStream + readline.createInterface is the standard streaming
    // pattern, but readline does NOT close the input stream on rl.close().
    // The file descriptor stays open and the underlying FSReqCallback never
    // fires its oncomplete — every cold start session.list that exercises
    // this path leaves one stranded FDRequest, and after a few dozen calls
    // the libuv thread pool is saturated by pending FSReqPromise objects
    // (measured: 35k+ on a 258-file store, event loop effectively wedged).
    // Destroy the input stream explicitly to release the fd.
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
    });
    let name: string | undefined;
    let facts: SessionFacts = {};
    let activityAt: number | undefined;
    let lineCount = 0;
    let headerFacts: SessionFacts | undefined;
    let sawFactsValue = false;
    // Whether ANY namespaced value record was seen. A current-format session
    // that was never named and never got facts (a plain user session, or a
    // fork/spawn session that never went through sessionPrompt's setName) is
    // normal — measured on a real store, 15 of 86 files have neither namespace
    // — so name/facts absence alone is not a format-change signal. Zero
    // namespaced records in a multi-line current-format file IS: pi always
    // writes pi.op.* / pi.lane.* during activity, so none means the
    // value-record encoding itself is gone.
    let sawNamespacedValue = false;
    // Whether the header says this file uses the value-record encoding this
    // scanner understands. A pi v3 legacy file stores its title as a
    // `{type: "session_info", name}` entry with no namespace at all, so the
    // absence of name/facts lines there is expected, not a format change.
    let currentFormat = false;
    try {
        for await (const line of rl) {
            lineCount++;
            if (lineCount === 1) {
                const parsed = parseSessionFileHeader(line);
                currentFormat = parsed.format === "v4";
                if (parsed.format === "v3") headerFacts = parsed.facts;
            }
            if (line.includes('"namespace":"')) {
                sawNamespacedValue = true;
            }
            // Substring test before JSON.parse: the overwhelming majority of
            // lines are neither namespaced values nor messages, and parsing
            // them is exactly the cost this function exists to avoid.
            const maybeName = line.includes(SESSION_NAME_NAMESPACE);
            const maybeFacts = line.includes(SESSION_FACTS_NAMESPACE);
            const maybeMessage = line.includes('"type":"message"');
            if (!maybeName && !maybeFacts && !maybeMessage) {
                continue;
            }
            try {
                const parsed = JSON.parse(line) as unknown;
                // pi commits a multi-write batch as a JSON *array* on one line,
                // not an object. Today only runtime state (pi.op.*, pi.lane.*,
                // pi.branch.tip) is ever batched, so name/facts always arrive as
                // single objects — but reading only the object shape means a
                // future batched name write parses to an array whose `.kind` is
                // undefined and gets skipped, losing the title with no error.
                // Flatten instead, so both encodings work.
                const records = Array.isArray(parsed) ? parsed : [parsed];
                for (const record of records) {
                    if (record === null || typeof record !== "object") continue;
                    const rec = record as ValueRecord & {
                        type?: unknown;
                        timestamp?: unknown;
                    };
                    if (maybeName || maybeFacts) applyValueRecord(rec);
                    if (maybeMessage) {
                        const ts = messageTimestamp(rec);
                        if (ts !== undefined) {
                            activityAt = activityAt === undefined ? ts : Math.max(activityAt, ts);
                        }
                    }
                }
            } catch {
                // A torn last line (crash mid-append) must not fail the list.
                // Keep whatever earlier values we already found.
            }
        }
    } finally {
        rl.close();
        // Force the underlying file handle closed so libuv's request queue
        // does not accumulate stranded FSReqPromise objects. Without this,
        // session.list paths that scan many .jsonl files drive the daemon
        // heap up to multiple GB and the event loop stops accepting new
        // RPCs — see commit message for the wedge-detector measurements.
        if (!stream.destroyed) stream.destroy();
    }

    function applyValueRecord(entry: ValueRecord): void {
        if (entry.kind !== "value" || entry.namespace === undefined) return;
        // A cleared value is `op: "delete"` (or a non-typed value),
        // which must reset the winner rather than keep the previous
        // value.
        const cleared = entry.op === "delete";
        if (entry.namespace === SESSION_NAME_NAMESPACE) {
            if (cleared || typeof entry.value !== "string") {
                name = undefined;
                return;
            }
            name = entry.value.trim() || undefined;
        } else if (entry.namespace === SESSION_FACTS_NAMESPACE) {
            sawFactsValue = true;
            if (cleared || typeof entry.value !== "object" || entry.value === null) {
                facts = {};
                return;
            }
            facts = entry.value as SessionFacts;
        }
    }
    // Only a *current-format* file with content but no namespaced value
    // records at all is suspicious — pi writes pi.op.* / pi.lane.* during
    // normal activity, so the encoding clearly still resolves whenever any
    // are present. What remains is the case worth a log: the file claims the
    // encoding this scanner targets, has content, yet no value record of any
    // kind resolved — i.e. a pi upgrade replaced the encoding under us and
    // `session.list` would silently show untitled, un-fact'd sessions.
    // Legacy (v3) files and fresh never-named sessions must stay quiet; the
    // measured store has many of both, and a warning that fires on almost
    // every session stops meaning anything.
    //
    // Deliberately info, not warn: the desktop client turns every sidecar
    // warn-level line into a UI warning, and this diagnostic is for the log
    // only — nothing the user can act on in the app.
    if (currentFormat && lineCount > 1 && !sawNamespacedValue) {
        log.info(
            "scanned jsonl found no namespaced value records; storage format may have changed",
            {
                path,
                lineCount,
            },
        );
    }
    // A v3 file has no taco.session.facts namespace. The header bag is the
    // only durable record of kind/parent until something opens (and
    // upgrades) the file. Fall back only when no value-store facts record
    // was seen — `kind === undefined` is not the same: a later write of
    // `{parentSessionId, depth}` has no kind but must still win.
    if (!sawFactsValue && headerFacts !== undefined) {
        facts = headerFacts;
    }
    return { name, facts, activityAt };
}

/**
 * Timestamp of a user-visible message record, in epoch milliseconds.
 *
 * v4 entries: `{kind:"entry", type:"message", timestamp:<ms>}`.
 * v3 records: `{type:"message", timestamp:"<ISO>"}`.
 * Compaction / branch_summary / value records are ignored — those rewrite
 * the file without a new conversation turn, which is what leaked into the
 * sidebar when we used mtime.
 */
function messageTimestamp(record: { type?: unknown; timestamp?: unknown }): number | undefined {
    if (record.type !== "message") return undefined;
    const raw = record.timestamp;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === "string") {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}
