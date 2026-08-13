import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { RpcRequest } from "@taco-ai/protocol";
import { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";

/** Minimal ServerRpcSurface stub: only implements what ConversationRouter uses. */
function stubHook(opts?: {
    existingSessionIds?: Set<string>;
}): ServerRpcSurface & { created: string[] } {
    const created: string[] = [];
    const existing = opts?.existingSessionIds ?? new Set<string>();
    const hook = {
        created,
        dispatchRpc: async (req: { method: string; params?: Record<string, unknown> }) => {
            if (req.method === "session.create") {
                const sid = String(req.params?.sessionId ?? "");
                created.push(sid);
                existing.add(sid);
                return { ok: true };
            }
            if (req.method === "session.history") {
                return existing.has(String(req.params?.sessionId ?? ""))
                    ? { ok: true }
                    : { ok: false };
            }
            return { ok: false };
        },
    } as unknown as ServerRpcSurface & { created: string[] };
    return hook;
}

describe("ConversationRouter", () => {
    it("routes a triple to a stable sessionId and reuses it", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        const hook = stubHook();
        const router = await ConversationRouter.load(home);
        const a = await router.route(hook, "ch1", "u1", "c1");
        const b = await router.route(hook, "ch1", "u1", "c1");
        assert.equal(a.sessionId, b.sessionId);
        assert.equal(hook.created.length, 1); // second call reuses, no new session
        assert.equal(a.workspace, "im://ch1/u1/c1");
    });

    it("creates a new session when the routed session no longer exists", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        const hook = stubHook();
        const router = await ConversationRouter.load(home);
        const a = await router.route(hook, "ch1", "u1", "c1");
        // simulate session deleted: use a hook that doesn't know about it
        const hook2 = stubHook();
        const b = await router.route(hook2, "ch1", "u1", "c1");
        assert.notEqual(b.sessionId, a.sessionId);
    });

    it("serializes concurrent routes for the same triple — one session created", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        const hook = stubHook();
        const router = await ConversationRouter.load(home);

        let releaseCreate!: () => void;
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const gated = {
            ...hook,
            dispatchRpc: async (req: RpcRequest) => {
                if (req.method === "session.create") await createGate;
                return hook.dispatchRpc?.(req);
            },
        } as ServerRpcSurface & { created: string[] };

        const before = hook.created.length;
        const p1 = router.route(gated, "ch1", "u1", "c1");
        const p2 = router.route(gated, "ch1", "u1", "c1");
        assert.equal(gated.created.length, before); // no create yet while first route is in flight
        releaseCreate();
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.sessionId, r2.sessionId);
        assert.equal(gated.created.length, before + 1); // lock prevented a duplicate create
    });

    it("persists routing.json and reloads it", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        const hook = stubHook();
        const router = await ConversationRouter.load(home);
        const a = await router.route(hook, "ch1", "u1", "c1");
        const reloaded = await ConversationRouter.load(home);
        assert.equal(reloaded.lookup("ch1", "u1", "c1")?.sessionId, a.sessionId);
    });

    /**
     * An earlier bug wrote keys with an empty chatId (iLink sends group_id as
     * "" for 1:1 chats). Such a key cannot round-trip through parseImCwd, so a
     * cached hit resolves no peer and every reply is dropped. Loading must skip
     * it and let the next inbound message recreate the route.
     */
    it("drops unparseable routing keys on load", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        const dir = path.join(home, "sessions", "im");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            path.join(dir, "routing.json"),
            JSON.stringify({
                "im://wechat/peer%40im.wechat/": { sessionId: "stale-1", lastUsedAt: 1 },
                "im://wechat/peer%40im.wechat/peer%40im.wechat": {
                    sessionId: "good-1",
                    lastUsedAt: 2,
                },
            }),
        );

        const router = await ConversationRouter.load(home);

        assert.equal(
            router.lookup("wechat", "peer@im.wechat", "peer@im.wechat")?.sessionId,
            "good-1",
        );
        assert.equal(router.findRouteBySessionId("stale-1"), undefined);
    });

    it("rebuilds routes from jsonl metadata when routing.json is missing", async () => {
        const home = mkdtempSync(path.join(tmpdir(), "router-"));
        // pre-seed a jsonl with imRouting metadata (routing.json absent)
        const dir = path.join(home, "sessions", "im", "ch1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            path.join(dir, "_sess-xyz.jsonl"),
            JSON.stringify({
                type: "session",
                version: 3,
                id: "sess-xyz",
                timestamp: new Date().toISOString(),
                cwd: "im://ch1/u9/c9",
                metadata: { imRouting: { channelId: "ch1", peerId: "u9", chatId: "c9" } },
            }) + "\n",
        );
        const reloaded = await ConversationRouter.load(home);
        assert.equal(reloaded.lookup("ch1", "u9", "c9")?.sessionId, "sess-xyz");
    });

    describe("listAll", () => {
        it("returns every routed conversation, newest first", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);

            await router.route(hook, "ch1", "u1", "c1");
            await new Promise((r) => setTimeout(r, 5));
            await router.route(hook, "ch1", "u2", "c2");
            await new Promise((r) => setTimeout(r, 5));
            await router.route(hook, "ch2", "u3", "c3");

            const entries = router.listAll();
            assert.equal(entries.length, 3);
            // Sorted by lastUsedAt desc → ch2/u3 first, then ch1/u2, then ch1/u1
            assert.deepEqual(
                entries.map((e) => `${e.channelId}/${e.peerId}`),
                ["ch2/u3", "ch1/u2", "ch1/u1"],
            );
        });

        it("filters by channelId when provided", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);

            await router.route(hook, "ch1", "u1", "c1");
            await router.route(hook, "ch2", "u2", "c2");

            const entries = router.listAll("ch1");
            assert.equal(entries.length, 1);
            assert.equal(entries[0].channelId, "ch1");
            assert.equal(entries[0].peerId, "u1");
        });

        it("skips unparseable keys silently (defensive)", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const dir = path.join(home, "sessions", "im");
            mkdirSync(dir, { recursive: true });
            // Same key shape the load-time skip covers — must also be skipped on
            // listAll to avoid surfacing "im:///" rows in the UI.
            writeFileSync(
                path.join(dir, "routing.json"),
                JSON.stringify({
                    "im://ch1/u1/": { sessionId: "stale", lastUsedAt: 1 },
                    "im://ch1/u1/c1": { sessionId: "good", lastUsedAt: 2 },
                }),
            );
            const router = await ConversationRouter.load(home);
            const entries = router.listAll();
            assert.equal(entries.length, 1);
            assert.equal(entries[0].sessionId, "good");
        });
    });

    describe("'conversation' event", () => {
        it("emits only when a NEW session is created", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);
            const events: unknown[] = [];
            router.on("conversation", (e) => events.push(e));

            // First route → new session → event fires.
            await router.route(hook, "ch1", "u1", "c1");
            assert.equal(events.length, 1);
            // Re-routing the same triple reuses the session → no event.
            await router.route(hook, "ch1", "u1", "c1");
            assert.equal(events.length, 1);
            // A different triple → new session → another event.
            await router.route(hook, "ch1", "u2", "c2");
            assert.equal(events.length, 2);
        });

        it("reports the same lastUsedAt the route entry carries", async () => {
            // Sampling Date.now() separately for the entry and the payload let
            // the push disagree with what listAll() returns for that key.
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);
            const events: { sessionId: string; lastUsedAt: number }[] = [];
            router.on("conversation", (e) => events.push(e));

            await router.route(hook, "ch1", "u1", "c1");
            const listed = router.listAll();
            assert.equal(events.length, 1);
            assert.equal(events[0].lastUsedAt, listed[0].lastUsedAt);
        });
    });

    describe("persist serialization", () => {
        it("survives concurrent routes without corrupting routing.json", async () => {
            // persist() writes via a shared `${path}.tmp` + rename. Overlapping
            // writers would let one rename publish another's half-written file,
            // so the whole point of tmp+rename is lost without serialization.
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);

            await Promise.all([
                router.route(hook, "ch1", "u1", "c1"),
                router.route(hook, "ch1", "u2", "c2"),
                router.route(hook, "ch1", "u3", "c3"),
                router.route(hook, "ch2", "u4", "c4"),
            ]);

            // routing.json must be valid JSON containing every route — a torn
            // write shows up as a parse error or a missing key.
            const raw = readFileSync(path.join(home, "sessions", "im", "routing.json"), "utf8");
            const parsed = JSON.parse(raw) as Record<string, { sessionId: string }>;
            assert.equal(Object.keys(parsed).length, 4);

            // And the reloaded view must agree with the in-memory one.
            const reloaded = await ConversationRouter.load(home);
            assert.equal(reloaded.listAll().length, 4);
        });
    });
});
