/**
 * Background subagent → Work → IM: the real AgentSpawner settle chain wired to
 * a real WorkService, with only the model run (executeSubagentSession), the
 * parent session and the channel faked.
 *
 * What these pin down is the contract between the three parts: the record is
 * committed before the settle is announced, the parent model's reply is what
 * the peer reads, and a notice is never sent twice or silently dropped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { asSessionId, type ImRoute, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import type { Channel, ChannelHandle, SendOutboundResult } from "../../src/channels/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import {
    addPendingSubagentResult,
    readPendingSubagentResults,
} from "../../src/runtime/subagent/subagentPending.ts";
import { WorkService } from "../../src/work/workService.ts";
import { interrupt } from "../../src/work/workState.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const agents: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "explores",
        systemPrompt: "you explore",
        tools: ["read"],
        runtime: "pi",
        source: "builtin",
        filePath: "/x/explorer.md",
    } as unknown as AgentDefinition,
];

const route = { channelId: "chan-1", peerId: "peer", chatId: "chat", bindingId: "test-binding" };

class FakeChannelHandle implements ChannelHandle {
    getDeliveryBinding(): string {
        return "test-binding";
    }
    readonly sent: { route: ImRoute; text: string }[] = [];
    results: SendOutboundResult[] = [];
    async push(): Promise<void> {}
    async close(): Promise<void> {}
    async sendText(r: ImRoute, text: string): Promise<SendOutboundResult> {
        this.sent.push({ route: r, text });
        return this.results.shift() ?? { kind: "confirmed" };
    }
}

describe("work × background subagent", () => {
    let tmp: string;
    let ws: ReturnType<typeof createTestWorkspace>["ws"];
    let cwd: string;
    let cleanup: () => Promise<void>;
    let service: WorkService;
    let handle: FakeChannelHandle;
    let routes: Map<string, ImRoute>;
    let launchSeq = 0;

    before(() => {
        tmp = mkdtempSync(join(tmpdir(), "taco-work-bg-"));
        // The service must exist before the workspace: the spawner takes its hooks at construction.
        routes = new Map();
        const channels = new ChannelRegistry();
        handle = new FakeChannelHandle();
        channels.register(
            "chan-1",
            {
                manifest: {
                    name: "fake",
                    version: "1",
                    capabilities: { maxMessageLength: 100 },
                },
                start: async () => handle,
            } as Channel,
            handle,
        );
        service = new WorkService({
            root: join(tmp, "work"),
            instanceId: "inst-1",
            channels,
            resolveRoute: (sid) => routes.get(sid),
        });
        ({ ws, cwd, cleanup } = createTestWorkspace({
            prefix: "work-bg",
            agents,
            workHooks: service,
        }));
    });

    after(async () => {
        service.stop();
        await ws.agentSpawner.whenBackgroundRunsSettle();
        await cleanup();
        rmSync(tmp, { recursive: true, force: true });
    });

    beforeEach(() => {
        handle.sent.length = 0;
        handle.results = [];
    });

    /** Swap the model run for a stub that resolves with `resultText`. */
    function stubRun(
        resultText: string,
        extra: { isError?: boolean; partial?: boolean; aborted?: boolean } = {},
    ) {
        const spawner = ws.agentSpawner as unknown as { executeSubagentSession: unknown };
        const original = spawner.executeSubagentSession;
        spawner.executeSubagentSession = async (args: { childSessionId?: SessionId }) => ({
            subSessionId: args.childSessionId ?? asSessionId("unused"),
            resultText,
            isError: extra.isError ?? false,
            ...(extra.partial ? { partial: true } : {}),
            ...(extra.aborted ? { aborted: true } : {}),
        });
        return () => {
            spawner.executeSubagentSession = original;
        };
    }

    /** A parent whose prompt/enqueue behaviour the test controls. */
    function stubParent(behaviour: {
        prompt?: (text: string) => Promise<unknown>;
        enqueue?: () => void;
        busy?: boolean;
        absent?: boolean;
    }) {
        const registry = ws.sessionRegistry as unknown as { getAttached: (id: unknown) => unknown };
        const original = registry.getAttached;
        registry.getAttached = () => {
            if (behaviour.absent) return undefined;
            return {
                prompt: async (text: string) => {
                    if (behaviour.busy) {
                        const e = new Error("busy");
                        (e as { code?: string }).code = "LaneBusy";
                        throw Object.assign(e, { _tag: "LaneBusy" });
                    }
                    return behaviour.prompt?.(text);
                },
                enqueue: async () => {
                    behaviour.enqueue?.();
                    return { mode: "queued" };
                },
            };
        };
        return () => {
            registry.getAttached = original;
        };
    }

    async function launch(parent: string, imRoute?: ImRoute) {
        await seed(parent);
        if (imRoute) routes.set(parent, imRoute);
        const toolCallId = `tc-${launchSeq++}`;
        const res = await ws.agentSpawner.spawnSubagent({
            parentSessionId: asSessionId(parent),
            parentToolCallId: toolCallId,
            agentType: "explorer",
            prompt: "look",
            description: "Find the leak",
            background: true,
        });
        await ws.agentSpawner.whenBackgroundRunsSettle();
        return {
            toolCallId,
            workId: service.workIdFor(asSessionId(parent), toolCallId, ws.workspaceKey),
            res,
        };
    }

    async function seed(id: string): Promise<void> {
        try {
            const session = await ws.repo.create({ id, cwd }, harnessContext);
            await session.close(harnessContext);
            ws.sessionRegistry.invalidateListCache();
        } catch {
            // already seeded by an earlier launch of the same parent
        }
    }

    async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            if (await check()) return;
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.fail(`timed out waiting for ${what}`);
    }

    it("records the Work before the run finishes and settles it with the result", async () => {
        const restoreRun = stubRun("found it in cache.ts");
        const restoreParent = stubParent({ absent: true });
        try {
            const { workId } = await launch("p-plain", undefined);
            const work = await service.store.get(workId);
            assert.equal(work?.status, "completed");
            assert.equal(work?.agentType, "explorer");
            assert.equal(work?.title, "Find the leak");
            assert.equal(work?.result?.completeness, "full");
            assert.equal(work?.delivery, undefined, "no IM target, nothing to deliver");
        } finally {
            restoreRun();
            restoreParent();
        }
    });

    it("a capped run is partial; a failed one is failed; a stopped one is cancelled", async () => {
        const restoreParent = stubParent({ absent: true });
        try {
            let restore = stubRun("half an answer", { partial: true });
            const partial = await launch("p-statuses", undefined);
            restore();
            restore = stubRun("it broke", { isError: true });
            const failed = await launch("p-statuses", undefined);
            restore();
            restore = stubRun("stopped", { isError: true, aborted: true });
            const stopped = await launch("p-statuses", undefined);
            restore();

            const a = await service.store.get(partial.workId);
            assert.equal(a?.status, "completed");
            assert.equal(a?.result?.completeness, "partial");
            assert.equal((await service.store.get(failed.workId))?.status, "failed");
            assert.equal((await service.store.get(stopped.workId))?.status, "cancelled");
        } finally {
            restoreParent();
        }
    });

    describe("IM parent, idle", () => {
        it("sends the parent model's reply to the peer, once, and not the template", async () => {
            const restoreRun = stubRun("raw subagent output");
            let sawHeld = false;
            const restoreParent = stubParent({
                prompt: async () => {
                    // The reply is being written: the channel must not also stream it.
                    sawHeld = service.controller.isHoldingReplies("p-idle");
                    return {
                        role: "assistant",
                        content: [{ type: "text", text: "The leak is in cache.ts." }],
                    };
                },
            });
            try {
                const { workId } = await launch("p-idle", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery",
                );
                assert.ok(sawHeld, "replies were held while the notice run was in flight");
                assert.deepEqual(
                    handle.sent.map((s) => s.text),
                    ["The leak is in cache.ts."],
                );
                assert.deepEqual(handle.sent[0]?.route, {
                    channelId: route.channelId,
                    peerId: route.peerId,
                    chatId: route.chatId,
                });
                assert.equal((await service.store.get(workId))?.delivery?.source, "parentReply");
                assert.equal(
                    service.controller.isHoldingReplies("p-idle"),
                    false,
                    "released after the run",
                );
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("two notice runs on one parent: the first to end keeps the second's hold", async () => {
            const restoreRun = stubRun("raw subagent output");
            let releaseSecond: () => void = () => undefined;
            let calls = 0;
            let heldWhileSecondRan: boolean | undefined;
            const restoreParent = stubParent({
                prompt: async () => {
                    calls++;
                    if (calls === 2) {
                        await new Promise<void>((resolve) => {
                            releaseSecond = resolve;
                        });
                        heldWhileSecondRan = service.controller.isHoldingReplies("p-pair");
                    }
                    return {
                        role: "assistant",
                        content: [{ type: "text", text: `reply ${calls}` }],
                    };
                },
            });
            try {
                await seed("p-pair");
                routes.set("p-pair", route);
                // Launch both before letting either settle, so the two notice runs overlap.
                const spawn = (tc: string) =>
                    ws.agentSpawner.spawnSubagent({
                        parentSessionId: asSessionId("p-pair"),
                        parentToolCallId: tc,
                        agentType: "explorer",
                        prompt: "look",
                        description: "Find the leak",
                        background: true,
                    });
                await spawn("tc-pair-1");
                await spawn("tc-pair-2");
                const first = service.workIdFor(
                    asSessionId("p-pair"),
                    "tc-pair-1",
                    ws.workspaceKey,
                );
                await until(
                    async () => (await service.store.get(first))?.delivery?.status === "confirmed",
                    "the first notice",
                );
                await until(() => calls === 2, "the second notice run to start");
                releaseSecond();
                await ws.agentSpawner.whenBackgroundRunsSettle();
                assert.equal(
                    heldWhileSecondRan,
                    true,
                    "the second run's reply must stay held after the first run ended",
                );
                assert.equal(service.controller.isHoldingReplies("p-pair"), false);
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("a late notice preserves model awareness but suppresses a second channel reply", async () => {
            const restoreRun = stubRun("answer");
            const restoreParent = stubParent({ absent: true });
            let workId = "";
            try {
                ({ workId } = await launch("p-late", route));
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "template delivery",
                );
            } finally {
                restoreParent();
            }
            let heldDuringLateRun: boolean | undefined;
            const restoreLate = stubParent({
                prompt: async () => {
                    heldDuringLateRun = service.controller.isHoldingReplies("p-late");
                    return { role: "assistant", content: [{ type: "text", text: "late words" }] };
                },
            });
            try {
                const spawner = ws.agentSpawner as unknown as {
                    deliverNotice: (p: SessionId, n: string, w: string) => Promise<boolean>;
                };
                await spawner.deliverNotice(asSessionId("p-late"), "notice", workId);
                assert.equal(
                    heldDuringLateRun,
                    true,
                    "the user already received the template, so the late reply must stay held",
                );
                assert.equal((await service.store.get(workId))?.delivery?.source, "template");
                assert.equal(handle.sent.length, 1);
            } finally {
                restoreRun();
                restoreLate();
            }
        });

        it("flushes parent awareness after template delivery without sending another notification", async () => {
            const restoreRun = stubRun("answer");
            let workId = "";
            let toolCallId = "";
            const restoreAbsent = stubParent({ absent: true });
            try {
                ({ workId, toolCallId } = await launch("p-flushed", route));
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "template delivery",
                );
            } finally {
                restoreAbsent();
            }
            // A pending record that survived the crash, as the flush path sees it.
            await ws.sessionRegistry.withSession(asSessionId("p-flushed"), (session) =>
                addPendingSubagentResult(session, {
                    parentToolCallId: toolCallId,
                    subSessionId: asSessionId("child-flushed"),
                    agentType: "explorer",
                    outcome: "completed",
                    settledAt: Date.now(),
                }),
            );

            let prompts = 0;
            const restoreParent = stubParent({
                prompt: async () => {
                    prompts++;
                    return { role: "assistant", content: [{ type: "text", text: "again" }] };
                },
            });
            try {
                const spawner = ws.agentSpawner as unknown as {
                    flushPendingSubagentResults(p: SessionId): Promise<void>;
                };
                await spawner.flushPendingSubagentResults(asSessionId("p-flushed"));
                assert.equal(prompts, 1, "delivery to the user does not update the parent model");
                await spawner.flushPendingSubagentResults(asSessionId("p-flushed"));
                assert.equal(prompts, 1, "a repeated flush must not prompt twice");
                assert.equal(handle.sent.length, 1);
                const pending = await ws.sessionRegistry.withSession(
                    asSessionId("p-flushed"),
                    (session) => readPendingSubagentResults(session),
                );
                assert.equal(toolCallId in pending, false, "nothing left to redeliver");
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("falls back to the template when the parent model says nothing", async () => {
            const restoreRun = stubRun("the answer text");
            const restoreParent = stubParent({
                prompt: async () => ({ role: "assistant", content: [] }),
            });
            try {
                const { workId } = await launch("p-silent", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery",
                );
                assert.match(
                    handle.sent[0]?.text ?? "",
                    /^Background task finished: Find the leak/,
                );
                assert.match(handle.sent[0]?.text ?? "", /the answer text/);
                assert.equal((await service.store.get(workId))?.delivery?.source, "template");
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("keeps the reply held when template fallback wins during a parent run", async () => {
            const restoreRun = stubRun("the answer text");
            const parent = asSessionId("p-fallback-race");
            const toolCallId = "tc-fallback-race";
            const workId = service.workIdFor(parent, toolCallId, ws.workspaceKey);
            let heldAfterFallback = false;
            const restoreParent = stubParent({
                prompt: async () => {
                    assert.equal(service.controller.isHoldingReplies(parent), true);
                    await service.controller.replyFailed(workId);
                    await until(
                        async () =>
                            (await service.store.get(workId))?.delivery?.status === "confirmed",
                        "fallback delivery while parent still runs",
                    );
                    heldAfterFallback = service.controller.isHoldingReplies(parent);
                    return { role: "assistant", content: [{ type: "text", text: "late words" }] };
                },
            });
            try {
                await seed(parent);
                routes.set(parent, route);
                await ws.agentSpawner.spawnSubagent({
                    parentSessionId: parent,
                    parentToolCallId: toolCallId,
                    agentType: "explorer",
                    prompt: "look",
                    background: true,
                });
                await ws.agentSpawner.whenBackgroundRunsSettle();
                assert.equal(heldAfterFallback, true);
                assert.equal(service.controller.isHoldingReplies(parent), false);
                assert.equal(handle.sent.length, 1);
                assert.equal((await service.store.get(workId))?.delivery?.source, "template");
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("falls back to the template when the notice run throws, and releases the hold", async () => {
            const restoreRun = stubRun("the answer text");
            const restoreParent = stubParent({
                prompt: async () => {
                    throw new Error("model exploded");
                },
            });
            try {
                const { workId } = await launch("p-throws", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery",
                );
                assert.equal((await service.store.get(workId))?.delivery?.source, "template");
                assert.equal(service.controller.isHoldingReplies("p-throws"), false);
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("a failed subagent still tells the peer, with the failure framed as one", async () => {
            const restoreRun = stubRun("boom", { isError: true });
            const restoreParent = stubParent({ absent: true });
            try {
                const { workId } = await launch("p-fail", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery",
                );
                assert.match(handle.sent[0]?.text ?? "", /^Background task failed/);
            } finally {
                restoreRun();
                restoreParent();
            }
        });
    });

    describe("resume", () => {
        it("freezes the delivery target at launch, before any settle", async () => {
            const restoreRun = stubRun("answer");
            const restoreParent = stubParent({ absent: true });
            try {
                const { workId } = await launch("p-target", route);
                const work = await service.store.get(workId);
                assert.deepEqual(work?.deliveryTarget, route);
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("a resumed run reopens an interrupted Work and closes it without a channel copy", async () => {
            const { workId } = await service.controller.start({
                sourceEventId: "subagent:p-resume:tc-resume",
                parentSessionId: "p-resume",
                childSessionId: "c-resume",
                agentType: "explorer",
                title: "resume me",
            });
            await service.store.mutate(workId, (w) =>
                interrupt(w, { reason: "driver died", now: Date.now() }),
            );

            const handle = await service.onResumeStart(asSessionId("c-resume"));
            assert.equal((await service.store.get(workId))?.status, "running");

            await service.onResumeSettle(
                asSessionId("c-resume"),
                {
                    outcome: "completed",
                    resultText: "finished after resume",
                    partial: false,
                },
                handle,
            );
            const after = await service.store.get(workId);
            assert.equal(after?.status, "completed");
            assert.equal(after?.result?.summary, "finished after resume");
            assert.equal(after?.delivery, undefined, "the conversation carries it");
        });
    });

    describe("IM parent, busy", () => {
        it("replays an idle wake received while a busy claim release is writing", async () => {
            const restoreRun = stubRun("answer");
            const parent = asSessionId("p-deferred-idle");
            const restoreAbsent = stubParent({ absent: true });
            let workId: string;
            let toolCallId: string;
            try {
                ({ workId, toolCallId } = await launch(parent, route));
            } finally {
                restoreAbsent();
            }
            let unblock!: () => void;
            const gate = new Promise<void>((resolve) => {
                unblock = resolve;
            });
            let blocked = false;
            let busy = true;
            let prompts = 0;
            const originalEnd = service.endParentNotice;
            service.endParentNotice = async (...args) => {
                if (args[2].status === "not_run") {
                    blocked = true;
                    await gate;
                }
                return originalEnd.apply(service, args);
            };
            const restoreParent = stubParent({
                prompt: async () => {
                    prompts++;
                    if (busy) throw Object.assign(new Error("busy"), { _tag: "LaneBusy" });
                    ws.sessionRegistry.emit("session.idle", { sessionId: parent });
                    return { role: "assistant", content: [{ type: "text", text: "found it" }] };
                },
            });
            const spawner = ws.agentSpawner as unknown as {
                flushingParents: Set<SessionId>;
                flushPendingSubagentResults(id: SessionId, trackedOnly: boolean): Promise<void>;
            };
            const flushing = spawner.flushPendingSubagentResults(parent, true);
            try {
                await until(() => blocked, "busy release to reach its write");
                assert.equal(spawner.flushingParents.has(parent), true);
                busy = false;
                ws.sessionRegistry.emit("session.idle", { sessionId: parent });
                ws.sessionRegistry.emit("session.idle", { sessionId: parent });
                unblock();
                await flushing;
                await until(async () => {
                    const pending = await ws.sessionRegistry.withSession(
                        parent,
                        readPendingSubagentResults,
                    );
                    return !(toolCallId in pending) && !spawner.flushingParents.has(parent);
                }, "deferred idle flush to clear the pending notice");
                assert.equal(prompts, 2, "one busy attempt and one accepted prompt");
                assert.equal((await service.store.get(workId))?.parentNotice?.state, "completed");
            } finally {
                unblock();
                await flushing;
                service.endParentNotice = originalEnd;
                restoreRun();
                restoreParent();
            }
        });

        it("retries busy notices on session.idle without duplicate prompts or channel sends", async () => {
            const restoreRun = stubRun("answer");
            let queued = 0;
            const restoreParent = stubParent({ busy: true, enqueue: () => queued++ });
            try {
                const { workId, toolCallId } = await launch("p-busy", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "template fallback",
                );
                assert.equal(queued, 0);
                assert.equal(handle.sent.length, 1);
                const pending = await ws.sessionRegistry.withSession(
                    asSessionId("p-busy"),
                    readPendingSubagentResults,
                );
                assert.equal(toolCallId in pending, true);
                // Regression: a rejected attempt used to leave the hold in place, so
                // every later reply from this session was swallowed.
                assert.equal(
                    service.controller.isHoldingReplies("p-busy"),
                    false,
                    "a busy rejection must not keep holding the session's replies",
                );
                restoreParent();
                let prompts = 0;
                const restoreIdle = stubParent({
                    prompt: async () => {
                        prompts++;
                        assert.equal(service.controller.isHoldingReplies("p-busy"), true);
                        ws.sessionRegistry.emit("session.idle", {
                            sessionId: asSessionId("p-busy"),
                        });
                        return {
                            role: "assistant",
                            content: [{ type: "text", text: "late words" }],
                        };
                    },
                });
                try {
                    ws.sessionRegistry.emit("session.idle", { sessionId: asSessionId("p-busy") });
                    ws.sessionRegistry.emit("session.idle", { sessionId: asSessionId("p-busy") });
                    await until(async () => {
                        const pending = await ws.sessionRegistry.withSession(
                            asSessionId("p-busy"),
                            readPendingSubagentResults,
                        );
                        return !(toolCallId in pending);
                    }, "idle flush to clear the pending notice");
                    assert.equal(prompts, 1);
                    assert.equal(handle.sent.length, 1);
                } finally {
                    restoreIdle();
                }
            } finally {
                restoreRun();
                restoreParent();
            }
        });
    });

    describe("IM parent, not attached", () => {
        it("sends the template rather than waiting for a reply nobody will write", async () => {
            const restoreRun = stubRun("answer");
            const restoreParent = stubParent({ absent: true });
            try {
                const { workId } = await launch("p-gone", route);
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery",
                );
                assert.equal(handle.sent.length, 1);
                assert.match(handle.sent[0]?.text ?? "", /Background task finished/);
            } finally {
                restoreRun();
                restoreParent();
            }
        });

        it("keeps trying through a platform failure and delivers once it recovers", async () => {
            const restoreRun = stubRun("answer");
            const restoreParent = stubParent({ absent: true });
            handle.results = [{ kind: "unavailable", code: "not_connected" }];
            try {
                const { workId } = await launch("p-recover", route);
                await until(async () => handle.sent.length === 1, "the first attempt");
                assert.equal((await service.store.get(workId))?.delivery?.status, "pending");
                service.onChannelConnected();
                await until(
                    async () => (await service.store.get(workId))?.delivery?.status === "confirmed",
                    "delivery after reconnect",
                );
                assert.equal(handle.sent.length, 2);
            } finally {
                restoreRun();
                restoreParent();
            }
        });
    });

    it("a store failure does not stop the subagent from launching or settling", async () => {
        const restoreRun = stubRun("answer");
        const restoreParent = stubParent({ absent: true });
        const original = service.store.createIfAbsent.bind(service.store);
        service.store.createIfAbsent = async () => {
            throw new Error("disk full");
        };
        try {
            const { res } = await launch("p-disk", undefined);
            assert.equal(res.background, true, "the launch receipt still came back");
        } finally {
            service.store.createIfAbsent = original;
            restoreRun();
            restoreParent();
        }
    });

    it("does not replay a live legacy notice when its prompt emits session.idle", async () => {
        const restoreRun = stubRun("legacy result");
        const originalCreate = service.store.createIfAbsent;
        service.store.createIfAbsent = async () => {
            throw new Error("disk full");
        };
        let prompts = 0;
        const parent = asSessionId("p-legacy-idle");
        const restoreParent = stubParent({
            prompt: async () => {
                prompts++;
                ws.sessionRegistry.emit("session.idle", { sessionId: parent });
                return { role: "assistant", content: [{ type: "text", text: "legacy reply" }] };
            },
        });
        try {
            await launch(parent);
            const spawner = ws.agentSpawner as unknown as { flushingParents: Set<SessionId> };
            await until(() => !spawner.flushingParents.has(parent), "idle flush to finish");
            assert.equal(prompts, 1);
        } finally {
            service.store.createIfAbsent = originalCreate;
            restoreRun();
            restoreParent();
        }
    });
});
