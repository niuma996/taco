/**
 * session.* lifecycle handlers — create, attach, detach, delete, rename, list.
 *
 * These handlers touch workspace.repo / invalidateListCache / session
 * metadata; they do not interact with the harness turn loop.
 */

import type {
    AgentMessage,
    AttachParams,
    CreateSessionParams,
    DeleteSessionParams,
    RenameSessionParams,
    SessionId,
    SessionListCursor,
    SessionListEntry,
    SessionListParams,
} from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    ErrorCodes,
    SESSION_LIST_DEFAULT_LIMIT,
    SESSION_LIST_MAX_LIMIT,
    sessionAttachSchema,
    sessionCreateSchema,
    sessionDeleteSchema,
    sessionDetachSchema,
    sessionListSchema,
    sessionRenameSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { JsonlSessionMetadata } from "../../runtime/pi/types.ts";
import { uuidv7 } from "../../runtime/pi/values.ts";
import { isHiddenSubagentSession, type SessionFacts } from "../../runtime/session/sessionFacts.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

const log = createLogger("session:lifecycle");

export function registerSessionLifecycleHandlers(): void {
    registerMethod(
        RPC.sessionList,
        true,
        async ({ workspace, cwd, params }: MethodCtx<SessionListParams>) => {
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
                    .filter(
                        ({ facts, meta }) => !isHiddenSubagentSession(facts, meta.parentSessionId),
                    )
                    .map(({ facts, meta }) => buildSessionEntry(workspace, meta, facts)),
            );
            // Sort by updatedAt desc with createdAt fallback, id desc tiebreaker.
            const sorted = sortSessionsDesc(all);
            const limit = normalizeLimit(params.limit);
            if (params.full) {
                return {
                    workspace: cwd,
                    sessions: sorted,
                    total: sorted.length,
                };
            }
            const startIdx = findCursorIndex(sorted, params.cursor);
            const pageEnd = startIdx + limit;
            const page = sorted.slice(startIdx, pageEnd);
            const last = page[page.length - 1];
            const nextCursor: SessionListCursor | undefined =
                pageEnd < sorted.length && last
                    ? { updatedAt: last.updatedAt ?? last.createdAt, id: last.id }
                    : undefined;
            return {
                workspace: cwd,
                sessions: page,
                nextCursor,
                // Always the true workspace total (already computed in-memory
                // above), not just this page's size — the sidebar header shows
                // "N sessions" for the whole workspace, not the loaded count.
                total: sorted.length,
            };
        },
        { schema: sessionListSchema },
    );

    registerMethod(
        RPC.sessionCreate,
        true,
        async ({ workspace, params }: MethodCtx<CreateSessionParams>) => {
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
            if (params.initialPrompt || hasInitialImages) {
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
                            await attached.session.setName(title, harnessContext);
                        } catch (e) {
                            log.error("setName failed:", e);
                        }
                    }
                    assistantMessage = await attached.prompt(
                        params.initialPrompt ?? "",
                        params.initialImages,
                        params.uiLocale,
                    );
                    workspace.invalidateListCache();
                } catch (e) {
                    try {
                        await workspace.detach(asSessionId(meta.id));
                        await workspace.repo.delete(meta, harnessContext);
                        workspace.invalidateListCache();
                    } catch {
                        // Cleanup is best-effort; swallow.
                    }
                    throw e;
                }
            }
            return {
                sessionId: meta.id,
                filePath: meta.path,
                assistantMessage,
            };
        },
        { command: true, schema: sessionCreateSchema },
    );

    registerMethod(
        RPC.sessionAttach,
        true,
        async ({ server, cwd, workspace, params }: MethodCtx<AttachParams>) => {
            // Before attach: the `attached` frame itself is the first
            // sequenced push a reconnecting client sees, so the ring must be
            // seeded from disk tail before this handler emits anything.
            await server.hydrateSessionEvents(cwd, params.sessionId);
            await workspace.attach(params.sessionId, { thinkingLevel: params.thinkingLevel });
            // Read after attach so the client can tell a live agent tool call from
            // one orphaned by a previous process exit. A history read alone cannot:
            // both look like a toolCall with no toolResult on disk.
            return {
                attached: true,
                sessionId: params.sessionId,
                inFlightAgentToolCallIds: workspace.inFlightAgentToolCallIds(params.sessionId),
            };
        },
        { command: true, schema: sessionAttachSchema },
    );

    registerMethod(
        RPC.sessionDetach,
        true,
        async ({ workspace, params }: MethodCtx<AttachParams>) => {
            const attached = workspace.getAttached(params.sessionId);
            if (attached) await workspace.detach(params.sessionId);
            return { detached: true };
        },
        { command: true, schema: sessionDetachSchema },
    );

    registerMethod(
        RPC.sessionDelete,
        true,
        async ({ workspace, params }: MethodCtx<DeleteSessionParams>) => {
            await workspace.deleteSession(params.sessionId);
            return { deleted: true };
        },
        { command: true, schema: sessionDeleteSchema },
    );

    registerMethod(
        RPC.sessionRename,
        true,
        async ({ workspace, params }: MethodCtx<RenameSessionParams>) => {
            await workspace.renameSession(params.sessionId, params.name);
            return { renamed: true };
        },
        { command: true, schema: sessionRenameSchema },
    );
}

// ───────── helpers (module-local; not exported) ─────────

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
    return {
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
