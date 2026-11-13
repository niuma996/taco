/**
 * Where a background subagent's result text lands on disk.
 *
 * A background spawn cannot hand its answer back through the tool result, and
 * inlining the full text into the parent's conversation would charge the
 * parent's context for output it may never need. So the text is written to a
 * file and the notification carries only a path.
 *
 * Keyed by the *parent* session, so one recursive delete of the parent's
 * directory reclaims every result it owns.
 *
 * "Under sessionsRoot" is not "beside the JSONL": pi lays sessions out as
 * `<sessionsRoot>/<cwdSlug>/<ts>_<sid>.jsonl`, so this is a sibling of that
 * cwd directory — which is why `repo.delete` never reaches it and
 * `SessionRegistry.deleteSession` removes the whole `<sid>/` directory.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionId } from "@taco-ai/protocol";
import { createLogger } from "../../lib/logger.ts";

const log = createLogger("subagent:results");

/** `<sessionsRoot>/<parentSessionId>/subagent-results` */
export function subagentResultsDir(parentSessionId: SessionId, sessionsRoot: string): string {
    return join(sessionsRoot, parentSessionId, "subagent-results");
}

/**
 * Child session ids that already have a result file under this parent.
 *
 * A result file is written exactly when a background child settles, so its
 * presence is a durable "this one finished" marker — the only one that survives
 * a restart. The desktop needs it because a background spawn's tool call reports
 * `ok` from launch: without this, a child killed mid-run and a child that
 * finished normally are indistinguishable on history replay, and both would
 * render as completed.
 *
 * Says nothing about the *outcome*: the file is written for an errored child too.
 * "It finished" is what replay needs; the child's own session holds the detail.
 *
 * A missing directory is the normal case for a parent that never delegated in
 * the background, so it reads as empty rather than throwing.
 */
export async function settledSubagentResultIds(
    parentSessionId: SessionId,
    sessionsRoot: string,
): Promise<string[]> {
    try {
        const root = subagentResultsDir(parentSessionId, sessionsRoot);
        const entries = await readdir(root, { withFileTypes: true });
        const ids = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => entry.name.slice(0, -".md".length));
        const runScoped = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    const files = await readdir(join(root, entry.name)).catch((error: unknown) => {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                            log.error("run-scoped result directory read failed", {
                                parentSessionId,
                                childSessionId: entry.name,
                                error: error instanceof Error ? error.message : String(error),
                            });
                        }
                        return [];
                    });
                    return files.some((name) => name.endsWith(".md")) ? entry.name : undefined;
                }),
        );
        return [...new Set([...ids, ...runScoped.filter((id): id is string => id !== undefined)])];
    } catch (err) {
        // ENOENT is the normal case — see the doc comment. Anything else
        // (EACCES, EMFILE, transient I/O) must be loud: downstream reads
        // "no result file" as "never settled", so a swallowed error would
        // mark every finished child of this parent as failed on replay.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            log.error("readdir failed; treating as no settled results", parentSessionId, err);
        }
        return [];
    }
}

/**
 * `<sessionsRoot>/<parentSessionId>/subagent-results/<subSessionId>.md`
 *
 * `.md` because the body is a subagent's final assistant text, which is
 * markdown by construction. No timestamp in the name: `subSessionId` is a
 * uuidv7 and a child settles exactly once, so the path is both unique and
 * idempotent — a retried delivery rewrites the same file instead of leaving a
 * second copy behind.
 */
export function subagentResultPath(
    parentSessionId: SessionId,
    subSessionId: SessionId,
    sessionsRoot: string,
    runId?: string,
): string {
    return runId
        ? join(subagentResultsDir(parentSessionId, sessionsRoot), subSessionId, `${runId}.md`)
        : join(subagentResultsDir(parentSessionId, sessionsRoot), `${subSessionId}.md`);
}
