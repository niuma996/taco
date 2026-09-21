/**
 * Where a background subagent's result text lands on disk.
 *
 * A background spawn cannot hand its answer back through the tool result (that
 * already returned a launch receipt), and inlining the full text into the
 * parent's conversation would charge the parent's context for output it may
 * never need. So the text is written to a file and the notification carries
 * only a path.
 *
 * Shape mirrors `tasks/sessionTasksDir.ts` — `<sessionsRoot>/<sid>/<kind>` —
 * because these are the same class of thing: sidecar-owned auxiliary state that
 * must live beside the session's JSONL rather than inside it. The JSONL belongs
 * to pi's `JsonlSessionRepo` as an append-only branch log; writing anything
 * else into it would corrupt that structure.
 *
 * Keyed by the *parent* session, not the child: cleanup follows the parent's
 * lifetime, and the child's id is already in the filename so nothing is lost.
 */

import { join } from "node:path";
import type { SessionId } from "@taco-ai/protocol";

/** `<sessionsRoot>/<parentSessionId>/subagent-results` */
export function subagentResultsDir(parentSessionId: SessionId, sessionsRoot: string): string {
    return join(sessionsRoot, parentSessionId, "subagent-results");
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
): string {
    return join(subagentResultsDir(parentSessionId, sessionsRoot), `${subSessionId}.md`);
}
