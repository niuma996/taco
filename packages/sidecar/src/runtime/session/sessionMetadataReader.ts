/**
 * Session title / facts reader — scans a pi JSONL file on disk and returns
 * only the namespaced value records this sidecar cares about, without
 * materializing pi's full storage index.
 *
 * Split out of `SessionRegistry` because it is a pure file-format adapter:
 * it reads pi's private v4 encoding and knows nothing about the registry's
 * caches, the attached map, or session lifecycle.
 */

import { createReadStream } from "node:fs";
import * as readline from "node:readline";
import { createLogger } from "../../lib/logger.ts";
import type { SessionFacts } from "./sessionFacts.ts";

const log = createLogger("sidecar.sessionMetadataReader");

/**
 * Namespace pi 0.85 writes `session.setName()` into. Before 0.85 the title was
 * a `{kind: "fact", fact: "name"}` entry; it is now a value record, so the
 * scanner below must match this namespace or every session reads as untitled.
 */
const SESSION_NAME_NAMESPACE = "pi.session.name";

/** Namespace taco writes per-session facts into. Mirrors SESSION_NAME_NAMESPACE. */
const SESSION_FACTS_NAMESPACE = "taco.session.facts";

/** One pi value record as it appears on disk, seen through the fields we read. */
interface ValueRecord {
    readonly kind?: string;
    readonly op?: string;
    readonly namespace?: string;
    readonly value?: unknown;
}

/**
 * Does this first line look like pi's current (`JSONL_FORMAT_VERSION = 4`)
 * storage header?
 *
 * pi accepts two header shapes (`parseJsonlSessionHeader`): the current
 * `{v: 4, kind: "header", …}` and a legacy v3 `{type: "session", version: 3, …}`.
 * Only the former stores the title and facts as namespaced value records, which
 * is all this scanner can read. Mirrors pi's own discriminant — a structural
 * check on `kind`/`v`, not a version-number comparison — so a file pi would
 * route to its legacy reader is never mistaken for a broken current-format one.
 *
 * Returns false on an unparseable line: an unreadable header is not evidence
 * that the namespaces changed.
 */
function isCurrentFormatHeader(line: string): boolean {
    try {
        const header = JSON.parse(line) as { v?: unknown; kind?: unknown };
        return header.kind === "header" && header.v === 4;
    } catch {
        return false;
    }
}

/**
 * Scan titles and facts without materializing pi's full storage index for
 * `session.list`. Read to EOF because renames and fact updates append values;
 * parse only matching records and retain only the latest values.
 * This relies on pi's private v4 encoding. Log suspicious current-format
 * files with no namespaced values, but keep legacy and fresh files quiet.
 */
export async function readSessionMetadataFromDisk(
    path: string,
): Promise<{ name: string | undefined; facts: SessionFacts }> {
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
    let lineCount = 0;
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
                currentFormat = isCurrentFormatHeader(line);
            }
            if (line.includes('"namespace":"')) {
                sawNamespacedValue = true;
            }
            // Substring test before JSON.parse: the overwhelming majority of
            // lines are messages, and parsing them is exactly the cost this
            // function exists to avoid.
            if (!line.includes(SESSION_NAME_NAMESPACE) && !line.includes(SESSION_FACTS_NAMESPACE)) {
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
                    applyValueRecord(record as ValueRecord);
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
    return { name, facts };
}
