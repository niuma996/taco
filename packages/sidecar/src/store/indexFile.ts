/**
 * Derived index for a document store's record files.
 *
 * The record files stay authoritative: the index only caches the small
 * summary fields its caller needs without parsing every record payload.
 * It is disposable — a missing, unreadable, or unrecognized index falls back
 * to a full directory scan, and an entry whose file changed on disk is
 * re-read rather than trusted.
 *
 * Entries are compared by `{mtimeMs, ctimeMs, size}`. Including ctime detects
 * same-size hand edits that restore mtime. This is a staleness hint, not a
 * content hash; authoritative reads still come from the record files.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import { writeJsonAtomic } from "./atomicFile.ts";

const log = createLogger("sidecar.store.index");

/** Must start with `_`: every store's id validator rejects a leading underscore. */
export const INDEX_FILE = "_index.json";

const INDEX_VERSION = 1;

export interface IndexStamp {
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly size: number;
}

export interface IndexEntry<S> {
    readonly stamp: IndexStamp;
    readonly summary: S;
}

interface IndexDocument<S> {
    readonly version: number;
    readonly entries: Record<string, IndexEntry<S>>;
}

/** `undefined` signals an unusable index; the caller rebuilds by scanning. */
export async function readIndex<S>(
    root: string,
    isSafeId: (id: string) => boolean,
    isSummary: (value: unknown) => value is S,
): Promise<Record<string, IndexEntry<S>> | undefined> {
    let raw: string;
    try {
        raw = await readFile(join(root, INDEX_FILE), "utf8");
    } catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as IndexDocument<S>;
        if (parsed?.version !== INDEX_VERSION || typeof parsed.entries !== "object")
            return undefined;
        const entries: Record<string, IndexEntry<S>> = {};
        for (const [id, entry] of Object.entries(parsed.entries)) {
            if (
                !isSafeId(id) ||
                !Number.isFinite(entry?.stamp?.mtimeMs) ||
                !Number.isFinite(entry?.stamp?.ctimeMs) ||
                !Number.isFinite(entry?.stamp?.size) ||
                !isSummary(entry.summary)
            )
                return undefined;
            entries[id] = entry;
        }
        return entries;
    } catch {
        log.warn("ignoring unreadable store index; falling back to a directory scan", { root });
        return undefined;
    }
}

export async function stampOf(path: string): Promise<IndexStamp | undefined> {
    try {
        const info = await stat(path);
        return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export function sameStamp(a: IndexStamp | undefined, b: IndexStamp): boolean {
    return (
        a !== undefined && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
    );
}

export async function writeIndex<S>(
    root: string,
    entries: Record<string, IndexEntry<S>>,
): Promise<void> {
    const doc: IndexDocument<S> = { version: INDEX_VERSION, entries };
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(root, INDEX_FILE), doc, { secure: true });
}
