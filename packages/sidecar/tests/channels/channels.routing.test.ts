import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { RpcRequest, RpcResponse } from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    makeImCwd,
    parseImCwd,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { commitAttachments } from "../../src/attachments/attachmentStore.ts";
import { mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import type { ChannelBindStatus } from "../../src/channels/channelBindBroker.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import { DefaultChannelContext } from "../../src/channels/ingress.ts";
import type { ChannelConfig } from "../../src/channels/registry.ts";
import {
    IM_FS_TOOL_NAMES,
    IM_SHELL_TOOL_NAME,
    makeImSessionsRoot,
} from "../../src/channels/virtualWorkspace.ts";
import { createLogger } from "../../src/lib/logger.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { ConnectionServer } from "../../src/server/connectionServer.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { pdfToolCandidates } from "../../src/tools/pdfCandidates.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { stubModelFetch } from "../_helpers/stubModelFetch.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("conversationRouter", () => {
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

    describe("ingress media", () => {
        it("stages images as attachments so the composer inlines them once", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "ingress-"));
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-1",
                text: "look",
                media: [
                    {
                        kind: "image",
                        source: { kind: "base64", mimeType: "image/png", data: "AA" },
                    },
                    {
                        kind: "image",
                        source: { kind: "base64", mimeType: "image/bmp", data: "BB" },
                    },
                    { kind: "image", source: { kind: "url", value: "https://x/y.png" } },
                ],
            } as never);
            assert.equal(prompts.length, 1);
            // The caption is the sender's words and is kept; the url item
            // could not be staged, so the note says one file did not arrive.
            // The attachment list alone never shows what is missing.
            assert.match(
                String(prompts[0]?.text),
                /^look\n\n\[1 attachment\(s\) could not be delivered/,
            );
            // Images travel as attachments, not as inline image blocks: the
            // composer inlines them when the model can see one, so sending
            // them both ways would show the model the same picture twice.
            assert.equal(prompts[0]?.images, undefined);
            // Both base64 items stage; the url one cannot — the sidecar
            // cannot fetch what a channel only referenced.
            const ids = prompts[0]?.attachments as string[] | undefined;
            assert.equal(ids?.length, 2);
        });

        it("tells the model when a media-only message lost its file", async () => {
            const home = useTempTacoHome("ingress-media-refused");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            // No text and nothing stageable: without a note the prompt is
            // empty, so the model has nothing to answer and the sender gets
            // no signal that the file never arrived.
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-refused",
                text: "",
                media: [{ kind: "file", source: { kind: "url", value: "https://x/y.pdf" } }],
            } as never);
            assert.equal(prompts.length, 1);
            assert.match(String(prompts[0]?.text), /could not be delivered/);
            assert.equal(prompts[0]?.attachments, undefined);
        });

        it("keeps an empty prompt when a media-only message was fully staged", async () => {
            const home = useTempTacoHome("ingress-media-staged");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-staged",
                text: "",
                media: [
                    {
                        kind: "image",
                        source: {
                            kind: "base64",
                            mimeType: "image/png",
                            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
                        },
                    },
                ],
            } as never);
            assert.equal(prompts.length, 1);
            // The attachment is the message; no note is owed when nothing was lost.
            assert.equal(prompts[0]?.text, "");
            assert.equal((prompts[0]?.attachments as string[] | undefined)?.length, 1);
        });

        it("keeps a caption untouched when every file arrived", async () => {
            const home = useTempTacoHome("ingress-media-caption");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-caption",
                text: "what does this chart say?",
                media: [
                    {
                        kind: "image",
                        source: {
                            kind: "base64",
                            mimeType: "image/png",
                            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
                        },
                    },
                ],
            } as never);
            assert.equal(prompts.length, 1);
            // Nothing was lost, so the sender's words are the whole prompt.
            assert.equal(prompts[0]?.text, "what does this chart say?");
        });
    });

    describe("ingress attachments", () => {
        it("stages channel media so the prompt names it as an attachment", async () => {
            const home = useTempTacoHome("ingress-attachments");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-1",
                text: "",
                media: [
                    {
                        kind: "file",
                        name: "report.pdf",
                        source: {
                            kind: "base64",
                            mimeType: "application/pdf",
                            data: Buffer.from("%PDF-1.7").toString("base64"),
                        },
                    },
                ],
            } as never);
            assert.equal(prompts.length, 1);
            // The prompt names the staged file, so the sidecar commits it into
            // the session and names it in the hidden tag — the same pipeline
            // a desktop attachment takes.
            const ids = prompts[0]?.attachments as string[] | undefined;
            assert.equal(ids?.length, 1);
            assert.match(ids?.[0] ?? "", /^[0-9a-f-]{36}$/);

            // The id must resolve under the workspace the prompt will be
            // composed under, or the file is lost at commit time.
            const committed = await commitAttachments(
                ids ?? [],
                "im://ch1/u1/c1",
                join(home, "sessions"),
                "sid-1",
            );
            assert.equal(committed.length, 1);
            assert.equal(committed[0]?.name, "report.pdf");
            assert.equal(committed[0]?.kind, "file");
            assert.equal(readFileSync(committed[0]?.path ?? "").toString(), "%PDF-1.7");
        });

        it("adds an extension from the bytes when the channel name has none", async () => {
            const home = useTempTacoHome("ingress-name-extension");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-ext",
                text: "",
                media: [
                    {
                        kind: "image",
                        name: "image",
                        source: {
                            kind: "base64",
                            mimeType: "application/octet-stream",
                            data: Buffer.from([
                                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                            ]).toString("base64"),
                        },
                    },
                    {
                        kind: "file",
                        name: "file",
                        source: {
                            kind: "base64",
                            mimeType: "application/octet-stream",
                            data: Buffer.from("%PDF-1.7").toString("base64"),
                        },
                    },
                ],
            } as never);
            const ids = prompts[0]?.attachments as string[] | undefined;
            const committed = await commitAttachments(
                ids ?? [],
                "im://ch1/u1/c1",
                join(home, "sessions"),
                "sid-ext",
            );
            assert.deepEqual(committed.map((item) => item.name).sort(), ["file.pdf", "image.png"]);
        });

        it("keeps the text when the media cannot be staged", async () => {
            const home = useTempTacoHome("ingress-attachments-fail");
            const hook = stubHook();
            const prompts: Array<Record<string, unknown>> = [];
            const recording = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.prompt") {
                        prompts.push(req.params as Record<string, unknown>);
                        return { ok: true, id: req.id, result: {} };
                    }
                    return hook.dispatchRpc?.(req);
                },
            } as unknown as ServerRpcSurface;
            const router = await ConversationRouter.load(home);
            const ctx = new DefaultChannelContext(
                "ch1",
                recording,
                router,
                {} as never,
                createLogger("test"),
            );
            await ctx.ingress.submit({
                channelId: "ch1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "pm-2",
                text: "hello",
                media: [
                    // Not base64: the sidecar cannot stage what it cannot read.
                    { kind: "file", source: { kind: "url", value: "https://x/y.pdf" } },
                ],
            } as never);
            assert.equal(prompts.length, 1);
            // The sender's words survive; the note says the file did not.
            assert.match(
                String(prompts[0]?.text),
                /^hello\n\n\[1 attachment\(s\) could not be delivered/,
            );
            assert.equal(prompts[0]?.attachments, undefined);
        });
    });

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

        /**
         * routing.json is the only place peerId/chatId are persisted, so a missing
         * file means an empty table rather than a reconstruction from session
         * files. Pinned because an earlier version scanned sessions/im/ for an
         * `imRouting` metadata triple that pi 0.85 no longer stores.
         */
        it("starts with an empty table when routing.json is absent", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const dir = path.join(home, "sessions", "im", "ch1");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                path.join(dir, "_sess-xyz.jsonl"),
                `${JSON.stringify({
                    type: "session_info",
                    id: "sess-xyz",
                    cwd: home,
                })}\n`,
            );

            const router = await ConversationRouter.load(home);

            assert.equal(router.lookup("ch1", "u9", "c9"), undefined);
            assert.deepEqual(router.listAll(), []);
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
});

describe("virtualWorkspace", () => {
    describe("virtualWorkspace", () => {
        it("makeImCwd/parseImCwd round-trips plain ids", () => {
            const cwd = makeImCwd("feishu-app1", "u1", "c1");
            assert.equal(cwd, "im://feishu-app1/u1/c1");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "feishu-app1",
                peerId: "u1",
                chatId: "c1",
            });
        });

        it("round-trips ids containing encoded slashes", () => {
            const cwd = makeImCwd("ch", "peer/with/slash", "chat");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "ch",
                peerId: "peer/with/slash",
                chatId: "chat",
            });
        });

        it("parseImCwd returns undefined for non-im cwd", () => {
            assert.equal(parseImCwd("/home/user/proj"), undefined);
        });

        it("parseImCwd returns undefined for malformed im cwd", () => {
            assert.equal(parseImCwd("im://onlychannel"), undefined);
            assert.equal(parseImCwd("im://a//c"), undefined);
        });

        it("parseImCwd returns undefined for trailing/missing segment edge cases", () => {
            assert.equal(parseImCwd("im://ch/peer/"), undefined); // empty chatId
            assert.equal(parseImCwd("im://ch//chat"), undefined); // empty peerId
            assert.equal(parseImCwd("im:///a/b"), undefined); // empty channelId
        });

        it("parseImCwd returns undefined for invalid percent-encoding", () => {
            assert.equal(parseImCwd("im://ch/%zz/c1"), undefined);
        });

        it("round-trips percent-encoded reserved characters in peer/chat ids", () => {
            const cwd = makeImCwd("ch", "peer?a=1&b=2", "chat#1");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "ch",
                peerId: "peer?a=1&b=2",
                chatId: "chat#1",
            });
        });

        /**
         * An empty id produces a key parseImCwd cannot parse, which breaks the
         * outbound reply path silently. Fail at construction instead.
         */
        it("rejects an empty peerId or chatId", () => {
            assert.throws(() => makeImCwd("ch", "", "c1"), /peerId must not be empty/);
            assert.throws(() => makeImCwd("ch", "u1", ""), /chatId must not be empty/);
        });

        it("makeImSessionsRoot joins under tacoHome", () => {
            // Path is joined with `path.join` (POSIX "/" on Linux/macOS, "\"
            // on Windows). The original assertion hard-coded "/" and broke
            // on Windows.
            assert.equal(
                makeImSessionsRoot("/home/x/.taco", "ch1"),
                join("/home/x/.taco", "sessions", "im", "ch1"),
            );
        });

        it("IM fs/shell tool names match the registered tool names", () => {
            // The PDF tools are deferred candidates, not resident; both
            // surfaces register a name the IM deny list can refer to.
            const registered = new Set([
                ...defaultTools({}).map((t) => t.name),
                ...pdfToolCandidates().map((c) => c.name),
            ]);
            for (const disabled of IM_FS_TOOL_NAMES) {
                assert.ok(registered.has(disabled), `disabled tool ${disabled} is not registered`);
            }
            // Guard: non-fs tools must never be in the disabled list (would break IM sessions).
            // The PDF tools count as fs tools: they read and write files.
            const fsTools = new Set([
                "read",
                "write",
                "edit",
                "grep",
                "glob",
                "pdfMerge",
                "pdfSplit",
                "pdfFill",
                "pdfFields",
            ]);
            for (const disabled of IM_FS_TOOL_NAMES) {
                assert.ok(fsTools.has(disabled), `${disabled} is not an fs tool`);
            }
            assert.equal(IM_SHELL_TOOL_NAME, "shell");
            assert.ok(registered.has(IM_SHELL_TOOL_NAME), "shell tool is registered");
        });
    });

    describe("WorkspaceRuntime im:// construction", () => {
        it("constructs with an IM scope and denies filesystem and shell tools by default", () => {
            const scratch = mkdtempSync(path.join(tmpdir(), "im-scratch-"));
            const sessionsRoot = mkdtempSync(path.join(tmpdir(), "im-sessions-"));
            const ws = new WorkspaceRuntime({
                providerKeyStore: new ProviderKeyStore({}),
                scope: createWorkspaceScope(asWorkspaceId("im://mock-1/u1/c1"), scratch),
                sessionsRoot,
            });
            assert.equal(ws.sessionCwd, scratch);
            assert.equal(ws.workspaceKey, "im://mock-1/u1/c1");
            const names = ws.tools.map((t) => t.name);
            const disabled = [...IM_FS_TOOL_NAMES, IM_SHELL_TOOL_NAME];
            for (const fs of disabled) {
                assert.ok(!names.includes(fs), `expected ${fs} to be disabled`);
            }
        });
    });
});

describe("daemonOwnership", () => {
    const mockChannelConfig: ChannelConfig = {
        channelId: "mock-1",
        manifest: mockChannelManifest,
        config: {},
    };

    const home = useTempTacoHome("daemon-ownership");
    stubModelFetch();

    // Pushes may precede the reply, so frame count alone cannot identify an RPC response.
    async function request(transport: InMemoryTransport, req: RpcRequest): Promise<RpcResponse> {
        transport.simulateRequest(JSON.stringify(req));
        const deadline = Date.now() + 5000;
        for (;;) {
            const response = transport.sent.find(
                (frame): frame is RpcResponse => "ok" in frame && frame.id === req.id,
            );
            if (response) return response;
            await transport.waitForPushCount(
                transport.sent.length + 1,
                Math.max(1, deadline - Date.now()),
            );
        }
    }

    async function startPair(t: TestContext) {
        const sinks = new ClientSinkRegistry();
        const owner = new SidecarServer({
            providerKeyStore: new ProviderKeyStore({}),
            clientSinkRegistry: sinks,
        });
        const transports = [new InMemoryTransport(), new InMemoryTransport()];
        const connections = transports.map(
            (transport) => new ConnectionServer(owner, transport, sinks),
        );
        t.after(async () => {
            await Promise.all(connections.map((connection) => connection.stop()));
            await owner.stop();
        });
        await owner.start(new NullTransport(), [mockChannelConfig]);
        const initialized = [];
        for (const [index, connection] of connections.entries()) {
            await connection.start();
            const response = await request(transports[index], {
                id: `init-${index}`,
                method: "initialize",
                params: { protocolVersion: SIDECAR_PROTOCOL_VERSION, clientCapabilities: {} },
            });
            assert.ok(response.ok, JSON.stringify(response));
            initialized.push(response.result as { serverCapabilities: { channels: string[] } });
        }
        return { owner, transports, connections, initialized, sinks };
    }

    it("two initialized clients advertise the single host's running channel", async (t) => {
        const { owner, initialized } = await startPair(t);
        assert.deepEqual(owner.channelRegistry.startedIds(), ["mock-1"]);
        for (const result of initialized) {
            assert.deepEqual(result.serverCapabilities.channels, ["mock-1"]);
        }
    });

    it("two clients list the same session created by IM ingress", async (t) => {
        const { owner, transports } = await startPair(t);
        const { sessionId } = await owner.buildChannelContext("mock-1").ingress.submit({
            channelId: "mock-1",
            peerId: "u1",
            chatId: "c1",
            platformMessageId: "msg-list",
            text: "hello",
        });
        const workspace = "im://mock-1/u1/c1";
        for (const [index, transport] of transports.entries()) {
            const response = await request(transport, {
                id: `list-${index}`,
                method: "session.list",
                params: { workspace },
            });
            assert.ok(response.ok, JSON.stringify(response));
            const result = response.result as { sessions: { id: string }[] };
            assert.ok(result.sessions.some((session) => session.id === sessionId));
        }
        assert.deepEqual(owner.workspaceIds(), [workspace]);
        assert.equal(owner.conversationRouterView?.findRouteBySessionId(sessionId)?.peerId, "u1");
    });

    it("disconnecting every client leaves the host's channel serving IM ingress", async (t) => {
        const { owner, connections, sinks } = await startPair(t);
        await Promise.all(connections.map((connection) => connection.stop()));
        assert.equal(sinks.hasClient(), false);
        assert.deepEqual(owner.channelRegistry.startedIds(), ["mock-1"]);
        const { sessionId } = await owner.buildChannelContext("mock-1").ingress.submit({
            channelId: "mock-1",
            peerId: "u2",
            chatId: "c1",
            platformMessageId: "msg-after-disconnect",
            text: "still here",
        });
        const workspace = await owner.ensureWorkspace(
            asWorkspaceId(makeImCwd("mock-1", "u2", "c1")),
        );
        assert.ok((await workspace.listSessions()).some((session) => session.id === sessionId));
        assert.equal(owner.channelRegistry.has("mock-1"), true);
    });

    it("filesystem requests use the host runtime alongside IM workspaces", async (t) => {
        const { owner, transports } = await startPair(t);
        await owner.ensureWorkspace(asWorkspaceId(makeImCwd("mock-1", "u3", "c1")));
        const cwd = asWorkspaceId(mkdtempSync(join(home, "fs-workspace-")));
        const runtime = await owner.ensureWorkspace(cwd);
        const response = await request(transports[0], {
            id: "fs-create",
            method: "session.create",
            params: { workspace: cwd, sessionId: "host-fs-session" },
        });
        assert.ok(response.ok, JSON.stringify(response));
        const attached = await request(transports[0], {
            id: "fs-attach",
            method: "session.attach",
            params: { workspace: cwd, sessionId: "host-fs-session" },
        });
        assert.ok(attached.ok, JSON.stringify(attached));
        assert.equal(await owner.ensureWorkspace(cwd), runtime);
        assert.ok(runtime.getAttached(asSessionId("host-fs-session")));
        assert.ok(
            (await runtime.listSessions()).some((session) => session.id === "host-fs-session"),
        );
        assert.deepEqual(new Set(owner.workspaceIds()), new Set(["im://mock-1/u3/c1", cwd]));
    });
});

describe("channelBindBroker", () => {
    describe("ChannelBindBroker", () => {
        it("reports unbound for an unknown channel", () => {
            const broker = new ChannelBindBroker();
            assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
        });

        it("emits status on every transition", () => {
            const broker = new ChannelBindBroker();
            const seen: ChannelBindStatus[] = [];
            broker.on("status", (s: ChannelBindStatus) => seen.push(s));

            broker.requestScan("wechat", "https://qr.example/abc");
            broker.setState("wechat", "connected");

            assert.deepEqual(
                seen.map((s) => s.state),
                ["awaiting_scan", "connected"],
            );
            assert.equal(seen[0].qrUrl, "https://qr.example/abc");
        });

        it("resolves a pending verify-code request via submitVerifyCode", async () => {
            const broker = new ChannelBindBroker();
            let requestId: string | undefined;
            broker.on("status", (s: ChannelBindStatus) => {
                if (s.state === "awaiting_verify_code") requestId = s.requestId;
            });

            const pending = broker.requestVerifyCode("wechat", false);
            assert.ok(requestId);
            assert.equal(broker.submitVerifyCode(requestId, "123456"), true);
            assert.equal(await pending, "123456");
            assert.equal(broker.status("wechat").state, "connecting");
        });

        it("marks a retry request so the UI can say the code was wrong", () => {
            const broker = new ChannelBindBroker();
            const seen: ChannelBindStatus[] = [];
            broker.on("status", (s: ChannelBindStatus) => seen.push(s));

            void broker.requestVerifyCode("wechat", true).catch(() => {});
            assert.equal(seen[0].retry, true);
            broker.cancelAll();
        });

        it("submitVerifyCode returns false for an unknown requestId", () => {
            const broker = new ChannelBindBroker();
            assert.equal(broker.submitVerifyCode("no-such-id", "123456"), false);
        });

        it("rejects and marks expired when the verify code times out", async () => {
            const broker = new ChannelBindBroker(10);
            await assert.rejects(broker.requestVerifyCode("wechat", false), /timed out/);
            assert.equal(broker.status("wechat").state, "expired");
        });

        it("cancel rejects pending requests for that channel only", async () => {
            const broker = new ChannelBindBroker();
            const wechat = broker.requestVerifyCode("wechat", false);
            const feishu = broker.requestVerifyCode("feishu", false);

            broker.cancel("wechat");

            await assert.rejects(wechat, /binding cancelled/);
            broker.cancel("feishu");
            await assert.rejects(feishu, /binding cancelled/);
        });

        it("cancelAll rejects every pending request", async () => {
            const broker = new ChannelBindBroker();
            const a = broker.requestVerifyCode("wechat", false);
            const b = broker.requestVerifyCode("feishu", false);

            broker.cancelAll();

            await assert.rejects(a, /shutting down/);
            await assert.rejects(b, /shutting down/);
        });

        it("reset cancels pending and re-publishes unbound state", async () => {
            const broker = new ChannelBindBroker();
            broker.setState("wechat", "connected");
            const pending = broker.requestVerifyCode("wechat", false);

            broker.reset("wechat");

            await assert.rejects(pending, /binding cancelled/);
            assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
        });

        it("listStatuses reports every known channel", () => {
            const broker = new ChannelBindBroker();
            broker.setState("wechat", "connected");
            broker.setState("feishu", "unbound");

            assert.deepEqual(
                broker
                    .listStatuses()
                    .map((s) => s.channelId)
                    .sort(),
                ["feishu", "wechat"],
            );
        });

        it("flips connecting to error when the platform never answers", async () => {
            // A platform can decline in ways the SDK doesn't classify, firing
            // neither `authenticated` nor `error` — the UI would spin forever.
            const broker = new ChannelBindBroker(1000, 10);
            broker.setState("wecom", "connecting");
            await new Promise((r) => setTimeout(r, 30));
            const status = broker.status("wecom");
            assert.equal(status.state, "error");
            assert.match(status.message ?? "", /timed out/);
        });

        it("a successful connect disarms the connecting watchdog", async () => {
            const broker = new ChannelBindBroker(1000, 10);
            broker.setState("wecom", "connecting");
            broker.setState("wecom", "connected");
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(broker.status("wecom").state, "connected");
        });

        it("re-entering connecting restarts the watchdog clock", async () => {
            const broker = new ChannelBindBroker(1000, 40);
            broker.setState("wecom", "connecting");
            await new Promise((r) => setTimeout(r, 25));
            broker.setState("wecom", "connecting");
            // Past the first attempt's deadline, inside the second's.
            await new Promise((r) => setTimeout(r, 25));
            assert.equal(broker.status("wecom").state, "connecting");
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(broker.status("wecom").state, "error");
        });

        // All three entry points funnel into cancel(), the only place the
        // `connecting` watchdog is cleared; they differ only in what they publish
        // afterwards. Past the 10ms deadline the state must still be the one each
        // entry point left behind — never `error`, which would resurrect a channel
        // that no longer runs.
        it("cancel, reset and cancelAll all disarm the connecting watchdog", async () => {
            for (const { entry, disarm, state } of [
                {
                    entry: "cancel disarms the watchdog so a closed channel is not resurrected as error",
                    disarm: (b: ChannelBindBroker) => b.cancel("wecom", "channel closing"),
                    state: "connecting",
                },
                {
                    entry: "reset leaves a mid-connect channel unbound rather than error",
                    disarm: (b: ChannelBindBroker) => b.reset("wecom"),
                    state: "unbound",
                },
                {
                    entry: "cancelAll disarms watchdogs even with no pending verify requests",
                    disarm: (b: ChannelBindBroker) => b.cancelAll(),
                    state: "connecting",
                },
            ]) {
                const broker = new ChannelBindBroker(1000, 10);
                broker.setState("wecom", "connecting");
                disarm(broker);
                await new Promise((r) => setTimeout(r, 30));
                assert.equal(broker.status("wecom").state, state, entry);
            }
        });

        it("a second requestVerifyCode supersedes the prior pending entry", async () => {
            // The SDK re-fires onVerifyCode(isRetry=true) after the user enters a
            // wrong code. Without cancellation the prior timer would fire
            // verifyTimeoutMs later and setState("expired") over the fresh
            // awaiting_verify_code state.
            const broker = new ChannelBindBroker();
            const first = broker.requestVerifyCode("wechat", false);
            const second = broker.requestVerifyCode("wechat", true);

            await assert.rejects(first, /superseded/);
            assert.equal(broker.status("wechat").state, "awaiting_verify_code");
            // Exactly one pending entry remains — the second.
            assert.equal((broker as unknown as { pending: Map<string, unknown> }).pending.size, 1);

            // Resolve the second via the public submitVerifyCode path so its
            // promise settles and node --test doesn't hang on the dangling await.
            const { requestId } = broker.status("wechat");
            assert.ok(requestId, "broker should hold the awaiting_verify_code requestId");
            broker.submitVerifyCode(requestId, "123456");
            await assert.doesNotReject(second);
        });
    });
});
