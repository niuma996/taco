/**
 * session.* lifecycle handlers — create, attach, detach, delete, rename, list.
 *
 * These handlers touch workspace.repo / invalidateListCache / session
 * metadata; they do not interact with the harness turn loop.
 */

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
    AgentMessage,
    CreateSessionResult,
    SessionAttachResult,
    SessionDeleteResult,
    SessionDetachResult,
    SessionId,
    SessionListCursor,
    SessionListEntry,
    SessionRenameResult,
} from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    ErrorCodes,
    SESSION_LIST_DEFAULT_LIMIT,
    SESSION_LIST_MAX_LIMIT,
} from "@taco-ai/protocol";
import { composeForSession } from "../../attachments/composePrompt.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { JsonlSessionMetadata } from "../../runtime/pi/types.ts";
import { uuidv7 } from "../../runtime/pi/values.ts";
import { isHiddenSubagentSession, type SessionFacts } from "../../runtime/session/sessionFacts.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { rethrowAttachmentError } from "./attachment.ts";

const log = createLogger("session:lifecycle");

export function registerSessionLifecycleHandlers(): void {
    registerMethod("sessionList", true, async ({ workspace, cwd, params }) => {
        const list = await workspace.listSessions();
        // Subagent sessions are hidden from the main list. Kind lives in
        // taco facts (pi 0.85 removed the free-form metadata bag), so it
        // is read per session. Header parentSessionId is a second signal:
        // repo.create stamps it atomically, covering the window before
        // writeSessionFacts. A facts-read failure still yields {} so a
        // pre-0.85 user session stays visible — but a header parent still
        // hides the row.
        const entries = await Promise.all(
            list.map(async (m) => ({
                meta: m,
                facts: await workspace.getSessionFacts(m.id as SessionId).catch((err) => {
                    log.error(
                        "getSessionFacts failed in session.list; treating as unfacted",
                        m.id,
                        err,
                    );
                    return {} as Awaited<ReturnType<typeof workspace.getSessionFacts>>;
                }),
            })),
        );
        const all = await Promise.all(
            entries
                .filter(({ facts, meta }) => !isHiddenSubagentSession(facts, meta.parentSessionId))
                .map(({ facts, meta }) => buildSessionEntry(workspace, meta, facts)),
        );
        // Sort by updatedAt desc with createdAt fallback, id desc tiebreaker.
        const sorted = sortSessionsDesc(all);
        // The query filter runs before pagination, so the cursor and the
        // total both describe the filtered set — "load more" pages through
        // the matches, not through the workspace's whole list.
        const matched = filterSessionsByQuery(sorted, params.query);
        const limit = normalizeLimit(params.limit);
        if (params.full) {
            return {
                workspace: cwd,
                sessions: matched,
                total: matched.length,
            };
        }
        const startIdx = findCursorIndex(matched, params.cursor);
        const pageEnd = startIdx + limit;
        const page = matched.slice(startIdx, pageEnd);
        const last = page[page.length - 1];
        const nextCursor: SessionListCursor | undefined =
            pageEnd < matched.length && last
                ? { updatedAt: last.updatedAt ?? last.createdAt, id: last.id }
                : undefined;
        return {
            workspace: cwd,
            sessions: page,
            nextCursor,
            // Always the true count of what was listed (already computed
            // in-memory above), not just this page's size — the sidebar shows
            // "N sessions" for the whole workspace, not the loaded count.
            total: matched.length,
        };
    });

    registerMethod(
        "sessionCreate",
        true,
        async ({ workspace, params }) => {
            if (!workspace.defaultModel) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidState,
                    "no model configured — select a provider and model in Settings",
                );
            }
            const sessionId = params.sessionId ?? uuidv7();
            // `imRouting` used to be stashed in the session's metadata bag, which
            // pi 0.85 removed. Nothing ever read it back — IM routing is derived
            // from the workspace (`workspace.imRouting`) on every use — so it is
            // simply not persisted any more.
            const session = await workspace.repo.create(
                {
                    id: sessionId,
                    cwd: workspace.sessionCwd,
                },
                harnessContext,
            );
            const meta = session.metadata;
            // create() holds pi's open-session slot, and attach() below opens
            // the same id — which throws while this handle is still live.
            await session.close(harnessContext);
            workspace.invalidateListCache();

            let assistantMessage: AgentMessage | null = null;
            const hasInitialImages =
                params.initialImages !== undefined && params.initialImages.length > 0;
            const hasInitialAttachments =
                params.initialAttachments !== undefined && params.initialAttachments.length > 0;
            if (params.initialPrompt || hasInitialImages || hasInitialAttachments) {
                try {
                    const attached = await workspace.attach(asSessionId(meta.id), {
                        thinkingLevel: params.thinkingLevel,
                    });
                    const title = (params.initialPrompt ?? "")
                        .slice(0, 60)
                        .replace(/\n+/g, " ")
                        .trim();
                    if (title) {
                        try {
                            await workspace.setPlaceholderTitle(asSessionId(meta.id), title);
                        } catch (e) {
                            log.error("setPlaceholderTitle failed:", e);
                        }
                    }
                    const turn = await composeForSession(
                        workspace,
                        attached,
                        meta.id,
                        params.initialPrompt ?? "",
                        params.initialImages,
                        params.initialAttachments,
                    ).catch(rethrowAttachmentError);
                    assistantMessage = await attached.prompt(
                        turn.text,
                        turn.images,
                        params.uiLocale,
                    );
                    workspace.invalidateListCache();
                } catch (e) {
                    await rollbackCreatedSession(workspace, meta);
                    throw e;
                }
            }
            const result: CreateSessionResult = {
                sessionId: asSessionId(meta.id),
                filePath: meta.path,
                assistantMessage,
            };
            return result;
        },
        { command: true },
    );

    registerMethod(
        "sessionAttach",
        true,
        async ({ server, cwd, workspace, params }) => {
            // Before attach: the `attached` frame itself is the first
            // sequenced push a reconnecting client sees, so the ring must be
            // seeded from disk tail before this handler emits anything.
            await server.hydrateSessionEvents(cwd, params.sessionId);
            await workspace.attach(params.sessionId, { thinkingLevel: params.thinkingLevel });
            // Read after attach so the client can tell a live agent tool call from
            // one orphaned by a previous process exit. A history read alone cannot:
            // both look like a toolCall with no toolResult on disk.
            const result: SessionAttachResult = {
                attached: true,
                sessionId: params.sessionId,
                inFlightAgentToolCallIds: workspace.inFlightAgentToolCallIds(params.sessionId),
                // Background spawns need a second signal: their tool call says
                // `ok` from launch, so "not in flight" alone cannot separate a
                // child that finished from one this process never saw. The
                // result files can, and they outlive the process.
                settledBackgroundSubSessionIds: await workspace.settledBackgroundSubSessionIds(
                    params.sessionId,
                ),
            };
            return result;
        },
        { command: true },
    );

    registerMethod(
        "sessionDetach",
        true,
        async ({ workspace, params }) => {
            const attached = workspace.getAttached(params.sessionId);
            if (attached) await workspace.detach(params.sessionId);
            const result: SessionDetachResult = { detached: true };
            return result;
        },
        { command: true },
    );

    registerMethod(
        "sessionDelete",
        true,
        async ({ workspace, params }) => {
            await deleteSessionTree(workspace, params.sessionId);
            const result: SessionDeleteResult = { deleted: true };
            return result;
        },
        { command: true },
    );

    registerMethod(
        "sessionRename",
        true,
        async ({ workspace, params }) => {
            await workspace.renameSession(params.sessionId, params.name);
            const result: SessionRenameResult = { renamed: true };
            return result;
        },
        { command: true },
    );
}

// ───────── helpers (module-local; not exported) ─────────

/**
 * Undo `session.create` after its `initialPrompt` turn failed — but only while
 * there is nothing to lose.
 *
 * The create+prompt pair is not atomic from the user's side: the prompt writes
 * the user message (and tool calls, and any partial reply) to the transcript
 * before the turn can fail, and an abort or a provider error fails it just the
 * same. Deleting then would destroy a conversation the user watched happen —
 * and for a scheduled run, the only record of what it did. So the transcript is
 * removed only when no message was ever persisted (attach / model resolution
 * failed first), which is the case this rollback exists for.
 *
 * Uncertainty keeps the session: if the probe itself fails we cannot tell an
 * empty transcript from a full one, and a leftover empty session is cheap
 * while a deleted one is not recoverable.
 */
async function rollbackCreatedSession(
    workspace: WorkspaceRuntime,
    meta: JsonlSessionMetadata,
): Promise<void> {
    const sessionId = asSessionId(meta.id);
    try {
        await workspace.detach(sessionId);
        // The caches predate the failed turn; drop them so the probe reads disk.
        workspace.invalidateListCache();
        if ((await workspace.getSessionActivityAt(sessionId)) !== undefined) return;
        await workspace.repo.delete(meta, harnessContext);
        workspace.invalidateListCache();
    } catch (err) {
        log.error("session.create rollback failed; keeping the session", sessionId, err);
    }
}

/**
 * How long a delete waits for each subagent it aborts to unwind before giving
 * up on that child.
 */
const STOP_CHILD_TIMEOUT_MS = 5_000;

/**
 * Delete a session, everything spawned beneath it, and its sidecar-owned
 * auxiliary directory. Three stores have to go; no single call covers them:
 *
 *  - The transcript (`workspace.deleteSession` → `repo.delete`) — a `.jsonl`
 *    in pi's cwd directory for a subagent.
 *  - Its descendants' transcripts: pi records `parentSessionId` per session,
 *    so the tree is walkable from `listSessions()`. Nothing else removes
 *    them — the parent's delete does not cascade and `session.list` hides
 *    subagent sessions, so an orphan would be invisible and unreachable.
 *  - `<sessionsRoot>/<sid>/` — the `tasks/` and `subagent-results/`
 *    directories: `repo.delete` removes one file by path, and these are
 *    siblings of the cwd directory, not children of the transcript.
 *
 * Children go before the parent: a mid-way failure never orphans a transcript.
 *
 * A child that will not stop within `STOP_CHILD_TIMEOUT_MS` is skipped, not
 * fatal: a subagent stuck on a long tool call would make the session
 * undeletable — worse than the one leftover transcript the user never sees.
 */
async function deleteSessionTree(workspace: WorkspaceRuntime, sessionId: SessionId): Promise<void> {
    // Validate the raw RPC id before anything is deleted, not after.
    sessionAuxDir(workspace.sessionsRoot, sessionId);

    // Post-order list of every descendant: children before their own children.
    const ordered: SessionId[] = [];
    const collect = async (id: SessionId): Promise<void> => {
        const children = (await workspace.listSessions())
            .filter((meta) => meta.parentSessionId === id)
            .map((meta) => asSessionId(meta.id));
        for (const child of children) await collect(child);
        ordered.push(id);
    };
    await collect(sessionId);

    // Abort down the whole tree, not just the root: a grandchild is registered
    // against its own parent, so stopping only the direct children would leave
    // the innermost runs going.
    const stuck = new Set<SessionId>();
    for (const id of ordered) {
        for (const running of await workspace.agentSpawner.stopChildrenOf(
            id,
            STOP_CHILD_TIMEOUT_MS,
        )) {
            stuck.add(running);
        }
    }

    // `workspace.deleteSession` emits `session.deleted`, which other clients and
    // the server's per-session event buffer depend on.
    const deleted: SessionId[] = [];
    for (const id of ordered) {
        if (stuck.has(id)) continue;
        await workspace.deleteSession(id);
        deleted.push(id);
    }

    // Last: a child that settles after this point re-creates the directory in
    // its settle path, which is why the abort wait above has to come first.
    // Every deleted id owns one — a subagent's `tasks/` is keyed by its own id.
    for (const id of deleted) {
        await rm(sessionAuxDir(workspace.sessionsRoot, id), { recursive: true, force: true });
    }
}

/**
 * `<sessionsRoot>/<sid>` — the one place a path is built from an RPC parameter.
 *
 * `sessionDeleteSchema` only requires a non-empty id, and `asSessionId`
 * rejects nothing beyond the empty string, so `sessionId` is whatever the
 * caller sent. Every other delete path goes through metadata resolved from
 * the session list and never joins a raw input onto a root; this one does, so
 * the segment is checked to be a single path component before it can reach a
 * recursive delete. Without it a `../..` id would escape `sessionsRoot`.
 */
function sessionAuxDir(sessionsRoot: string, sessionId: SessionId): string {
    const root = resolve(sessionsRoot);
    const dir = resolve(root, sessionId);
    // A single-segment id resolves to a direct child of root; anything with a
    // separator, a `..`, or a leading `/` lands elsewhere and is rejected here.
    if (dirname(dir) !== root)
        throw new Error(`refusing to delete outside sessionsRoot: ${sessionId}`);
    return dir;
}

async function buildSessionEntry(
    workspace: WorkspaceRuntime,
    m: JsonlSessionMetadata,
    md: SessionFacts,
): Promise<SessionListEntry> {
    const activityAt = await workspace.getSessionActivityAt(asSessionId(m.id)).catch((err) => {
        log.error(
            "getSessionActivityAt failed in session.list; falling back to createdAt",
            m.id,
            err,
        );
        return undefined;
    });
    // Content time, not file mtime: a v3→v4 rewrite (or facts backfill)
    // updates mtime without a new message and would otherwise cluster every
    // upgraded session at "just now". No messages → createdAt.
    const updatedAtSource =
        typeof activityAt === "number" && Number.isFinite(activityAt) ? activityAt : m.createdAt;
    const updatedAt = new Date(updatedAtSource).toISOString();
    // Served from the scan getSessionActivityAt just ran, so no extra I/O.
    // A size hint must never fail the list — hence the catch, and `?.` for
    // partial workspace stand-ins.
    const messageCount = await workspace
        .getSessionMessageCount?.(asSessionId(m.id))
        .catch(() => undefined);
    return {
        ...(messageCount !== undefined ? { messageCount } : {}),
        id: asSessionId(m.id),
        cwd: asWorkspaceId(m.cwd),
        filePath: m.path,
        createdAt: new Date(m.createdAt).toISOString(),
        updatedAt,
        kind: md.kind ?? "main",
        agentType: md.agentType,
        // `parentSessionId` is standard 0.85 metadata; the fact is the fallback
        // for sessions written before it moved.
        parentSessionId:
            m.parentSessionId !== undefined
                ? asSessionId(m.parentSessionId)
                : md.parentSessionId !== undefined
                  ? asSessionId(md.parentSessionId)
                  : undefined,
        parentToolCallId: md.parentToolCallId,
        depth: md.depth,
        // A corrupt/parse-failed session file must not bring down the whole
        // list — fall back to undefined.
        name: await workspace.getSessionName(asSessionId(m.id)).catch((err) => {
            log.error("getSessionName failed in session.list; leaving untitled", m.id, err);
            return undefined;
        }),
    };
}

/** Sort by (updatedAt ?? createdAt) desc; id desc tiebreaker for stability
 *  across timestamp ties (same-second writes). */
export function sortSessionsDesc(sessions: SessionListEntry[]): SessionListEntry[] {
    return [...sessions].sort((a, b) => {
        const aTime = new Date(a.updatedAt ?? a.createdAt).getTime();
        const bTime = new Date(b.updatedAt ?? b.createdAt).getTime();
        if (bTime !== aTime) return bTime - aTime;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });
}

/** Locate the index in a sorted-desc list of the first entry strictly older
 *  than the cursor (by updatedAt, tiebreaker id). Returns 0 if cursor is
 *  absent or no longer matches. */
export function findCursorIndex(
    sorted: SessionListEntry[],
    cursor: SessionListCursor | undefined,
): number {
    if (!cursor) return 0;
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        if (!s) continue;
        const sTime = new Date(s.updatedAt ?? s.createdAt).getTime();
        const cTime = new Date(cursor.updatedAt).getTime();
        if (sTime < cTime) return i;
        if (sTime === cTime && s.id < cursor.id) return i;
    }
    return sorted.length;
}

/** Clamp so a misbehaving caller can't ask for an empty page or an unbounded read. */
export function normalizeLimit(limit: number | undefined): number {
    if (!limit || limit <= 0) return SESSION_LIST_DEFAULT_LIMIT;
    return Math.min(limit, SESSION_LIST_MAX_LIMIT);
}

/**
 * Keep the sessions whose title or id contains the query, case-insensitively.
 *
 * Title first, id second: the sidebar shows `name ?? id.slice(0, 8)`, so an
 * untitled session is searchable by the id prefix it displays. An empty or
 * whitespace-only query is no filter at all.
 */
export function filterSessionsByQuery(
    sessions: SessionListEntry[],
    query: string | undefined,
): SessionListEntry[] {
    const needle = query?.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
        (s) => (s.name ?? "").toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle),
    );
}
