import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImConversationEntry } from "@taco-ai/protocol";
import { makeImCwd, parseImCwd } from "@taco-ai/protocol";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import { uuidv7 } from "../runtime/pi/values.ts";
import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";

const log = createLogger("channel:router");

interface RouteEntry {
    sessionId: string;
    lastUsedAt: number;
}

/** routing.json is the source of truth for IM routing — peerId and chatId
 *  are not persisted anywhere else. If routing.json is missing/corrupt the
 *  routes are lost; the next inbound message will create a fresh session for
 *  that peer. */
export class ConversationRouter extends EventEmitter {
    private readonly routes = new Map<string, RouteEntry>(); // key = imCwd
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

    /** Loads routing.json on startup. Does not receive a ServerRpcSurface —
     *  load only reads files; the surface is passed to route() /
     *  sessionExists() at call time. */
    static async load(tacoHome: string): Promise<ConversationRouter> {
        const router = new ConversationRouter(tacoHome);
        let fileRead = false;
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
            fileRead = true;
        } catch (e) {
            // Absent file is the normal first-run path; corrupt content is not.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn(`routing.json unreadable: ${e}`);
            }
        }
        if (fileRead && router.routes.size === 0) {
            // The file parsed but yielded nothing usable, which means every key
            // was dropped above. Nothing else persists peerId/chatId, so those
            // conversations are unreachable until their peer messages in again.
            log.warn("routing.json carried no usable routes — peers will re-route on next message");
        }
        return router;
    }

    /** Reverse lookup for outbound replies: a push frame carries only a
     *  sessionId, but a channel must address the platform peer. */
    findRouteBySessionId(
        sessionId: string,
    ): { channelId: string; peerId: string; chatId: string } | undefined {
        for (const [workspace, entry] of this.routes) {
            if (entry.sessionId === sessionId) return parseImCwd(workspace);
        }
        return undefined;
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
        const sid = sessionId ?? uuidv7();
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
