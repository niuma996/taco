import { RPC, type SessionListEntry } from "@taco-ai/protocol";
import type { TacoToolContext } from "./context.ts";

const METADATA_PAGE_SIZE = 50;

/** Resolve live same-workspace history visibility without reading transcript content. */
export async function resolveVisibleSession(
    ctx: TacoToolContext,
    sessionId: string,
): Promise<SessionListEntry> {
    if (!ctx.call) throw new Error("sessionRead: no self-RPC dispatcher in this workspace");
    let cursor: { updatedAt: string; id: SessionListEntry["id"] } | undefined;
    const seen = new Set<string>();
    do {
        const result = await ctx.call(RPC.sessionList, ctx.workspace, {
            workspace: ctx.workspace,
            query: sessionId,
            limit: METADATA_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
        });
        const target = result.sessions.find(
            (s) =>
                s.id === sessionId &&
                s.cwd === ctx.workspace &&
                s.kind !== "subagent" &&
                !s.parentSessionId,
        );
        if (target) return target;
        cursor = result.nextCursor;
        if (cursor) {
            const key = JSON.stringify(cursor);
            if (seen.has(key))
                throw new Error("sessionRead: session list pagination did not advance");
            seen.add(key);
        }
    } while (cursor);
    throw new Error(
        "sessionRead: session not found or unavailable in this workspace (it may have been deleted).",
    );
}
