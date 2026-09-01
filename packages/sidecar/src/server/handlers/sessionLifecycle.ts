/**
 * session.* lifecycle handlers — create, attach, detach, delete, rename, list.
 *
 * These handlers touch workspace.repo / invalidateListCache / session
 * metadata; they do not interact with the harness turn loop.
 */

import { stat } from "node:fs/promises";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { createSessionId } from "@earendil-works/pi-agent-core";
import type {
    AssistantMessage,
    AttachParams,
    CreateSessionParams,
    DeleteSessionParams,
    RenameSessionParams,
    SessionListCursor,
    SessionListEntry,
    SessionListParams,
} from "@taco-ai/protocol";
import {
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
import { createLogger } from "../../lib/logger.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

const log = createLogger("session:lifecycle");

export function registerSessionLifecycleHandlers(): void {
    registerMethod(
        RPC.sessionList,
        true,
        async ({ workspace, cwd, params }: MethodCtx<SessionListParams>) => {
            const list = await workspace.listSessions();
            const all = await Promise.all(
                list
                    // Hide subagent sessions: the main list shows main sessions plus
                    // legacy data (no metadata => treated as main).
                    .filter((m) => {
                        const md = m.metadata as Record<string, unknown> | undefined;
                        const kind = md?.kind;
                        return kind === undefined || kind === "main";
                    })
                    .map((m) => buildSessionEntry(workspace, m)),
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
            const sessionId = params.sessionId ?? createSessionId();
            const imRouting = params.imRouting ?? workspace.imRouting;
            const session = await workspace.repo.create({
                id: sessionId,
                cwd: workspace.sessionCwd,
                ...(imRouting ? { metadata: { imRouting } } : {}),
            });
            workspace.invalidateListCache();
            const meta = await session.getMetadata();

            let assistantMessage: AssistantMessage | null = null;
            const hasInitialImages =
                params.initialImages !== undefined && params.initialImages.length > 0;
            if (params.initialPrompt || hasInitialImages) {
                try {
                    const attached = await workspace.attach(meta.id, {
                        thinkingLevel: params.thinkingLevel,
                    });
                    const title = (params.initialPrompt ?? "")
                        .slice(0, 60)
                        .replace(/\n+/g, " ")
                        .trim();
                    if (title) {
                        try {
                            await attached.session.appendSessionName(title);
                        } catch (e) {
                            log.error("appendSessionName failed:", e);
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
                        await workspace.detach(meta.id);
                        await workspace.repo.delete(meta);
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
        async ({ workspace, params }: MethodCtx<AttachParams>) => {
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
): Promise<SessionListEntry> {
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    // File mtime approximates "last activity" — the .jsonl is appended on every
    // turn (prompt writes a session_info entry too). Tolerate a stat failure
    // (file deleted/renamed between repo.list and here): leave undefined so
    // clients fall back to createdAt, and never take down the whole list.
    let updatedAt: string | undefined;
    try {
        updatedAt = (await stat(m.path)).mtime.toISOString();
    } catch {
        updatedAt = undefined;
    }
    return {
        id: m.id,
        cwd: m.cwd,
        filePath: m.path,
        createdAt: m.createdAt,
        updatedAt,
        kind: (md.kind as "main" | "subagent" | undefined) ?? "main",
        agentType: typeof md.agentType === "string" ? md.agentType : undefined,
        parentSessionId: typeof md.parentSessionId === "string" ? md.parentSessionId : undefined,
        parentToolCallId: typeof md.parentToolCallId === "string" ? md.parentToolCallId : undefined,
        depth: typeof md.depth === "number" ? md.depth : undefined,
        // A corrupt/parse-failed session file must not bring down the whole
        // list — fall back to undefined.
        name: await workspace.getSessionName(m.id).catch((err) => {
            log.error("getSessionName failed in session.list", m.id, err);
            return undefined;
        }),
    };
}

/** Sort by (updatedAt ?? createdAt) desc; id desc tiebreaker for stability
 *  across mtime ties (same-second writes). */
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
