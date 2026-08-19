import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionId } from "@earendil-works/pi-agent-core";
import type { ImConversationEntry } from "@taco-ai/protocol";
import { makeImCwd, parseImCwd } from "@taco-ai/protocol";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";

const log = createLogger("channel:router");

interface RouteEntry {
    sessionId: string;
    lastUsedAt: number;
}

/** routing.json is a cache, not the source of truth. The authoritative source is the
 *  imRouting triple in each session's jsonl metadata; when routing.json is
 *  missing/corrupt, scan sessions/im/<channelId>/ to rebuild without losing
 *  any user history. */
export class ConversationRouter extends EventEmitter {
    private readonly routes = new Map<string, RouteEntry>(); // key = imCwd
    /** Reverse-only index for sessions created outside `route()` (scheduler
     *  pin jobs). key = sessionId, value = imCwd. Kept separate from
     *  `routes` because that map is 1:1 per workspace and is owned by the
     *  peer's live conversation — see `registerExternalSession`. */
    private readonly externalRoutes = new Map<string, string>();
    private readonly inflight = new Map<
        string,
        Promise<{ workspace: string; sessionId: string }>
    >();
    private readonly persistPath: string;
    /** Debounce timer for the reuse path — a chatty peer would otherwise
     *  rewrite routing.json on every inbound message. */
    private persistTimer: ReturnType<typeof setTimeout> | undefined;
    /** Serializes persist() so concurrent callers cannot interleave on the
     *  shared `.tmp` path. See persist(). */
    private chain: Promise<void> = Promise.resolve();

    private constructor(tacoHome: string) {
        super();
        this.persistPath = path.join(tacoHome, "sessions", "im", "routing.json");
    }

    /** Loads routing.json on startup; rebuilds from jsonl metadata when missing/corrupt.
     *  Does not receive a ServerRpcSurface — load only reads files; the surface
     *  is passed to route() / sessionExists() at call time. */
    static async load(tacoHome: string): Promise<ConversationRouter> {
        const router = new ConversationRouter(tacoHome);
        let loadedFromCache = false;
        try {
            const raw = await fs.promises.readFile(router.persistPath, "utf8");
            const data = JSON.parse(raw) as Record<string, RouteEntry>;
            for (const [k, v] of Object.entries(data)) {
                if (!v || typeof v.sessionId !== "string") continue;
                // Drop keys that cannot round-trip (e.g. an empty peerId/chatId
                // written by an earlier bug): keeping them means route() hits a
                // cached key whose peer can never be resolved, so replies are
                // silently dropped forever. Skipping lets the next inbound
                // message recreate the route correctly.
                if (!parseImCwd(k)) {
                    log.warn(`unparseable routing key dropped, will be recreated: ${k}`);
                    continue;
                }
                router.routes.set(k, v);
            }
            loadedFromCache = router.routes.size > 0;
        } catch (e) {
            // Absent cache is the normal first-run path; corrupt content is not.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn(`routing.json unreadable, rebuilding from jsonl: ${e}`);
            }
        }
        if (!loadedFromCache) {
            await router.rebuildFromJsonl(tacoHome);
        }
        return router;
    }

    /** Scans sessions/im/<channelId>/*.jsonl, reads metadata.imRouting, restores routes. */
    private async rebuildFromJsonl(tacoHome: string): Promise<void> {
        const imRoot = path.join(tacoHome, "sessions", "im");
        let channelDirs: fs.Dirent[];
        try {
            channelDirs = await fs.promises.readdir(imRoot, { withFileTypes: true });
        } catch (e) {
            // No im directory — empty routing table is correct, not a fault.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn(`cannot scan ${imRoot}: ${e}`);
            }
            return;
        }
        for (const dir of channelDirs) {
            if (!dir.isDirectory()) continue;
            const dirPath = path.join(imRoot, dir.name);
            let files: string[];
            try {
                files = await fs.promises.readdir(dirPath);
            } catch (e) {
                log.warn(`cannot read channel dir ${dirPath}, routes may be lost: ${e}`);
                continue;
            }
            for (const file of files) {
                if (!file.endsWith(".jsonl")) continue;
                try {
                    const firstLine = (
                        await fs.promises.readFile(path.join(dirPath, file), "utf8")
                    ).split("\n", 1)[0];
                    const header = JSON.parse(firstLine) as {
                        id?: string;
                        metadata?: {
                            imRouting?: {
                                channelId: string;
                                peerId: string;
                                chatId: string;
                                routeRole?: "conversation" | "external";
                            };
                        };
                    };
                    const im = header.metadata?.imRouting;
                    if (im && header.id) {
                        // lastUsedAt has no persisted source after a rebuild —
                        // the jsonl file's mtime is the best available proxy for
                        // "when this peer was last active". 0 would render every
                        // row as 1970-01-01 and collapse the sort order.
                        let lastUsedAt = 0;
                        try {
                            lastUsedAt = (await fs.promises.stat(path.join(dirPath, file))).mtimeMs;
                        } catch {
                            /* stat failed — fall back to 0 rather than dropping the route */
                        }
                        const workspace = makeImCwd(im.channelId, im.peerId, im.chatId);
                        if (im.routeRole === "external") {
                            this.externalRoutes.set(header.id, workspace);
                        } else {
                            this.routes.set(workspace, { sessionId: header.id, lastUsedAt });
                        }
                    }
                } catch (e) {
                    // Skip corrupt files without affecting other routes — but say
                    // so: a silently dropped file means that peer loses history.
                    log.warn(`corrupt session file ${file}, route not restored: ${e}`);
                }
            }
        }
    }

    /** Reverse lookup for outbound replies: a push frame carries only a
     *  sessionId, but a channel must address the platform peer. */
    findRouteBySessionId(
        sessionId: string,
    ): { channelId: string; peerId: string; chatId: string } | undefined {
        for (const [workspace, entry] of this.routes) {
            if (entry.sessionId === sessionId) return parseImCwd(workspace);
        }
        // Fall back to sessions registered out-of-band (scheduler pin jobs).
        // Checked second so a live conversation always wins on the (rare)
        // chance both indexes name the same id.
        const external = this.externalRoutes.get(sessionId);
        return external ? parseImCwd(external) : undefined;
    }

    lookup(
        channelId: string,
        peerId: string,
        chatId: string,
    ):
        | {
              workspace: string;
              sessionId: string;
          }
        | undefined {
        const workspace = makeImCwd(channelId, peerId, chatId);
        const entry = this.routes.get(workspace);
        return entry ? { workspace, sessionId: entry.sessionId } : undefined;
    }

    lookupByWorkspace(workspace: string): { sessionId: string } | undefined {
        const entry = this.routes.get(workspace);
        return entry ? { sessionId: entry.sessionId } : undefined;
    }

    /**
     * Read-only enumeration of every IM conversation currently routed.
     * Sorted by `lastUsedAt` descending so the most recent chats surface
     * first — same ordering principle as SessionList. `channelId` filter
     * is applied before sorting, so the result is a stable per-channel
     * ordering, not a "first N across all channels" pick.
     */
    listAll(channelId?: string): ImConversationEntry[] {
        const entries: ImConversationEntry[] = [];
        for (const [workspace, entry] of this.routes) {
            const parsed = parseImCwd(workspace);
            if (!parsed) continue; // unparseable keys cannot be surfaced to the UI
            if (channelId && parsed.channelId !== channelId) continue;
            entries.push({
                channelId: parsed.channelId,
                peerId: parsed.peerId,
                chatId: parsed.chatId,
                sessionId: entry.sessionId,
                lastUsedAt: entry.lastUsedAt,
            });
        }
        entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        return entries;
    }

    async route(
        hook: ServerRpcSurface,
        channelId: string,
        peerId: string,
        chatId: string,
        sessionId?: string,
    ): Promise<{ workspace: string; sessionId: string }> {
        const key = makeImCwd(channelId, peerId, chatId);

        // Serialize concurrent routes for the same workspace so two identical
        // triples cannot both miss and create duplicate sessions.
        const inflight = this.inflight.get(key);
        if (inflight) return inflight;
        const pending = this.routeOnce(hook, key, channelId, peerId, chatId, sessionId);
        this.inflight.set(key, pending);
        try {
            return await pending;
        } finally {
            this.inflight.delete(key);
        }
    }

    private async routeOnce(
        hook: ServerRpcSurface,
        key: string,
        channelId: string,
        peerId: string,
        chatId: string,
        sessionId?: string,
    ): Promise<{ workspace: string; sessionId: string }> {
        const workspace = key;
        const existing = this.routes.get(workspace);
        // JsonlSessionRepo.create does not throw on duplicate ids and does not
        // overwrite — it produces two parallel files. We MUST check sessionExists
        // via session.history (not session.list, which filters subagents) before
        // creating to avoid duplicates.
        if (existing && (await this.sessionExists(hook, workspace, existing.sessionId))) {
            existing.lastUsedAt = Date.now();
            // Debounced, not immediate: the reuse path is hit on every inbound
            // message, and rewriting routing.json per message is disk churn.
            // 2s coalescing keeps the timestamp close enough to live for the
            // conversation list while not hammering the disk.
            if (!this.persistTimer) {
                this.persistTimer = setTimeout(() => {
                    this.persistTimer = undefined;
                    void this.persist().catch((e) => {
                        log.warn(`routing.json persist (debounced) failed: ${e}`);
                    });
                }, 2000);
                this.persistTimer.unref?.();
            }
            // sessionId arg is ignored on reuse — the existing route entry's id is
            // the authoritative session identity for this peer+chat conversation.
            return { workspace, sessionId: existing.sessionId };
        }

        // Use the caller-supplied id when given so the conversation uses a stable UUID
        // rather than leaking a platform message id into the session identity.
        const sid = sessionId ?? createSessionId();
        await hook.dispatchRpc?.({
            id: randomUUID(),
            method: "session.create",
            params: { workspace, sessionId: sid, imRouting: { channelId, peerId, chatId } },
        });

        // One timestamp for both the route entry and the event: sampling
        // Date.now() twice let the pushed payload disagree with what listAll()
        // would report for the same conversation.
        const lastUsedAt = Date.now();
        this.routes.set(workspace, { sessionId: sid, lastUsedAt });
        await this.persist();
        // Emit only on NEW session creation, not on every route() hit —
        // a busy peer's stream would otherwise turn this into a push-storm.
        // ServerRpcSurface subscribers (e.g. SidecarServer.imChannelListener) re-broadcast
        // as `channels.conversations_changed` to the desktop.
        this.emit("conversation", {
            channelId,
            peerId,
            chatId,
            sessionId: sid,
            lastUsedAt,
        });
        return { workspace, sessionId: sid };
    }

    /** Register a session that was created outside of `route()` (e.g. by the
     *  scheduler's pin strategy, which dispatches `session.create` directly
     *  with a stable id and skips the conversation-router create path).
     *
     *  Without this, `findRouteBySessionId(pinnedId)` returns nothing — the
     *  channel's reverse-lookup (`resolvePeer`) misses, and any reply the
     *  agent emits gets logged as "no peer for session, reply dropped".
     *
     *  This deliberately does NOT touch `routes`. That map is the forward
     *  index (`workspace -> the one session inbound messages go to`), and a
     *  peer's live conversation owns the same key. Writing the scheduler's
     *  session there would evict the human's session, so the peer's next
     *  message would land in the scheduler's session instead — hijacking
     *  the conversation. Outbound reply addressing only ever needs the
     *  reverse direction, so it gets its own many-to-one index and the
     *  forward map is left alone. Not persisted: it is rebuilt by whoever
     *  re-creates or re-attaches the session after a restart.
     *
     *  No-op on fs workspaces (no IM triple to bind). */
    registerExternalSession(workspace: string, sessionId: string): void {
        if (!parseImCwd(workspace)) return;
        this.externalRoutes.set(sessionId, workspace);
    }

    /**
     * Drop a sessionId from the reverse index. Called when:
     *   - the underlying session is deleted (`session.delete` RPC or its
     *     `session.deleted` workspace event),
     *   - the pin job that owned the session is deleted (the session
     *     may still be on disk but no scheduler is referencing it),
     *   - the pin job is edited away from `pin` strategy (the session
     *     becomes orphaned; the next fire won't reuse it).
     *
     * Returns true when a binding was actually removed. The reverse-only
     * index (`externalRoutes`) is not persisted — a stale entry here
     * survives only until the next daemon restart, when rebuildFromJsonl
     * re-walks the jsonl files. So an unregister that races a persist
     * on the same sessionId is at worst self-correcting: the rebuild
     * either restores the binding (jsonl still has the metadata) or
     * doesn't (jsonl was already gone), and we cannot tell those apart
     * from the in-memory state alone. Deletion is still correct because
     * a session without on-disk metadata cannot be addressed anyway.
     */
    unregisterExternalSession(sessionId: string): boolean {
        return this.externalRoutes.delete(sessionId);
    }

    /** Uses session.history (not session.list, which filters subagents).
     *  Any failure is treated as "session does not exist" — triggers the create path. */
    private async sessionExists(
        hook: ServerRpcSurface,
        workspace: string,
        sessionId: string,
    ): Promise<boolean> {
        try {
            const res = await hook.dispatchRpc?.({
                id: randomUUID(),
                method: "session.history",
                params: { workspace, sessionId },
            });
            return res?.ok === true;
        } catch (e) {
            // Falling back to "does not exist" creates a fresh session, so the
            // peer silently loses continuity — worth surfacing.
            log.child({ sid: sessionId }).warn(`session.history failed, treating as absent: ${e}`);
            return false;
        }
    }

    /**
     * Serialized through a promise chain (same pattern as
     * FileChannelConfigStore): the debounced reuse-path timer and the
     * new-session path are independent callers, and they share one `.tmp`
     * path. Overlapping writes would let one rename() publish another's
     * half-written file, defeating the point of writing via tmp+rename.
     */
    private persist(): Promise<void> {
        const run = this.chain.then(async () => {
            const data = Object.fromEntries(this.routes);
            const tmp = `${this.persistPath}.tmp`;
            await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
            await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
            await restrictOwner(tmp, 0o600);
            await fs.promises.rename(tmp, this.persistPath);
        });
        // Keep the chain alive on failure so one rejected write does not poison
        // every subsequent persist.
        this.chain = run.catch(() => {});
        return run;
    }
}
