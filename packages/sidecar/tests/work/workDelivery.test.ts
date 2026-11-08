/**
 * WorkDeliverer: which send result leads to which state, and the guarantees a
 * restart must keep (resume from the next unsent chunk, never from the top).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ImRoute } from "@taco-ai/protocol";
import type { SendOutboundResult } from "../../src/channels/types.ts";
import {
    backoffDelay,
    DELIVERY_BACKOFF_MS,
    DELIVERY_EXPIRY_MS,
    type DeliveryClock,
    type DeliverySender,
    MAX_DELIVERY_ATTEMPTS,
    PARENT_REPLY_GRACE_MS,
    PARENT_REPLY_MAX_WAIT_MS,
    UNAVAILABLE_RETRY_MS,
    WorkDeliverer,
} from "../../src/work/workDelivery.ts";
import { WorkStore, workIdForSource } from "../../src/work/workStore.ts";
import {
    WORK_SCHEMA_VERSION,
    type WorkDelivery,
    type WorkRecord,
} from "../../src/work/workTypes.ts";

const FIRST_BACKOFF_MS = DELIVERY_BACKOFF_MS[0] ?? 0;
const LONGEST_BACKOFF_MS = DELIVERY_BACKOFF_MS[DELIVERY_BACKOFF_MS.length - 1] ?? 0;

class FakeClock implements DeliveryClock {
    time = 1_000_000;
    timers: { at: number; fn: () => void; live: boolean }[] = [];
    now(): number {
        return this.time;
    }
    random(): number {
        return 0.5; // exactly the base delay: jitter is symmetric around it
    }
    setTimer(fn: () => void, ms: number): () => void {
        const timer = { at: this.time + ms, fn, live: true };
        this.timers.push(timer);
        return () => {
            timer.live = false;
        };
    }
    /** Move time forward and fire every timer that came due. */
    advance(ms: number): void {
        this.time += ms;
        for (const t of this.timers) {
            if (t.live && t.at <= this.time) {
                t.live = false;
                t.fn();
            }
        }
    }
    get pending(): number {
        return this.timers.filter((t) => t.live).length;
    }
}

class FakeSender implements DeliverySender {
    readonly calls: { channelId: string; route: ImRoute; text: string }[] = [];
    readonly script: SendOutboundResult[] = [];
    async sendText(
        channelId: string,
        route: ImRoute,
        text: string,
        _expected?: { bindingId: string },
    ): Promise<SendOutboundResult> {
        this.calls.push({ channelId, route, text });
        return this.script.shift() ?? { kind: "confirmed" };
    }
}

/**
 * Wait for a timer-triggered `deliver` (not awaitable from outside) to reach a
 * state. The store does real file IO, so yielding to the event loop a fixed
 * number of times is a guess; polling the observable is not.
 */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
}

const confirmed: SendOutboundResult = { kind: "confirmed" };
const retryable = (code = "net"): SendOutboundResult => ({ kind: "retryable", code });

describe("work.delivery", () => {
    let root: string;
    let seq = 0;

    before(() => {
        root = mkdtempSync(join(tmpdir(), "taco-work-delivery-"));
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    function rig() {
        const clock = new FakeClock();
        const sender = new FakeSender();
        const store = new WorkStore(join(root, `s${seq++}`));
        const changes: string[] = [];
        const deliverer = new WorkDeliverer(store, sender, clock, (id) => changes.push(id));
        return { clock, sender, store, deliverer, changes };
    }

    async function seed(
        store: WorkStore,
        clock: FakeClock,
        delivery: Partial<WorkDelivery> = {},
        work: Partial<WorkRecord> = {},
    ): Promise<string> {
        const sourceEventId = `subagent:p:${seq++}`;
        const workId = workIdForSource(sourceEventId);
        const record: WorkRecord = {
            schemaVersion: WORK_SCHEMA_VERSION,
            workId,
            revision: 0,
            kind: "subagent",
            title: "t",
            sourceEventId,
            parentSessionId: "p",
            childSessionId: "c",
            agentType: "explorer",
            status: "completed",
            ownerInstanceId: "inst-1",
            createdAt: clock.time,
            updatedAt: clock.time,
            endedAt: clock.time,
            attempt: { attemptId: "a", startedAt: clock.time, endedAt: clock.time },
            delivery: {
                deliveryId: "d-1",
                target: {
                    channelId: "wechat-1",
                    peerId: "peer",
                    chatId: "chat",
                    bindingId: "test-binding",
                },
                status: "pending",
                chunks: ["one"],
                source: "template",
                maxMessageLength: 100,
                confirmedChunks: 0,
                attempts: 0,
                createdAt: clock.time,
                ...delivery,
            },
            ...work,
        };
        await store.createIfAbsent(record);
        return workId;
    }

    const deliveryOf = async (store: WorkStore, id: string) => (await store.get(id))?.delivery;

    it("does not adopt the current account for a legacy delivery without frozen identity", async () => {
        const { clock, sender, store, deliverer } = rig();
        const id = await seed(store, clock, {
            target: { channelId: "wechat-1", peerId: "peer", chatId: "chat" },
        });
        await deliverer.deliver(id);
        assert.equal(sender.calls.length, 0);
        assert.equal((await deliveryOf(store, id))?.status, "permanentFailure");
        assert.equal((await deliveryOf(store, id))?.lastError, "binding_unverified");
    });

    it("sends each chunk with the immutable launch binding", async () => {
        const { clock, sender, store, deliverer } = rig();
        const expected: Array<unknown> = [];
        sender.sendText = async (_channel, _route, _text, binding) => {
            expected.push(binding);
            return { kind: "confirmed" };
        };
        const id = await seed(store, clock, {
            target: {
                channelId: "wechat-1",
                peerId: "peer",
                chatId: "chat",
                bindingId: "launch-binding",
            },
            chunks: ["one", "two"],
        });
        await deliverer.deliver(id);
        assert.deepEqual(expected, [
            { bindingId: "launch-binding" },
            { bindingId: "launch-binding" },
        ]);
    });

    it("confirms after the platform accepts every chunk, in order", async () => {
        const { clock, sender, store, deliverer } = rig();
        const id = await seed(store, clock, { chunks: ["a", "b", "c"] });
        await deliverer.deliver(id);
        assert.deepEqual(
            sender.calls.map((c) => c.text),
            ["a", "b", "c"],
        );
        const d = await deliveryOf(store, id);
        assert.equal(d?.status, "confirmed");
        assert.equal(d?.confirmedChunks, 3);
    });

    it("sends to the frozen target, not whatever the session maps to now", async () => {
        const { clock, sender, store, deliverer } = rig();
        const id = await seed(store, clock, {
            target: { channelId: "wecom-9", peerId: "p9", chatId: "c9", bindingId: "test-binding" },
        });
        await deliverer.deliver(id);
        assert.equal(sender.calls[0]?.channelId, "wecom-9");
        assert.deepEqual(sender.calls[0]?.route, {
            channelId: "wecom-9",
            peerId: "p9",
            chatId: "c9",
        });
    });

    describe("failure handling", () => {
        it("keeps the confirmed chunk and retries from the failed one", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, { chunks: ["a", "b", "c"] });
            sender.script.push(confirmed, retryable());
            await deliverer.deliver(id);
            let d = await deliveryOf(store, id);
            assert.equal(d?.status, "pending");
            assert.equal(d?.confirmedChunks, 1, "the accepted chunk is not forgotten");
            assert.equal(d?.attempts, 1);

            sender.calls.length = 0;
            clock.advance(FIRST_BACKOFF_MS + 1);
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the retry to finish",
            );
            assert.deepEqual(
                sender.calls.map((c) => c.text),
                ["b", "c"],
                "resumes at b, never resends a",
            );
            d = await deliveryOf(store, id);
            assert.equal(d?.status, "confirmed");
        });

        it("does not send again before the backoff has elapsed", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push(retryable());
            await deliverer.deliver(id);
            sender.calls.length = 0;
            await deliverer.deliver(id);
            assert.equal(sender.calls.length, 0);
            assert.equal(clock.pending, 1, "a timer is armed for the retry");
        });

        it("honours retryAfterMs when the platform asks for longer than the backoff", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push({ kind: "retryable", code: "429", retryAfterMs: 10 * 60_000 });
            await deliverer.deliver(id);
            const d = await deliveryOf(store, id);
            assert.ok((d?.nextAttemptAt ?? 0) - clock.time >= 10 * 60_000);
        });

        it("gives up after the attempt budget and says so", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) sender.script.push(retryable());
            await deliverer.deliver(id);
            // Each failure arms its own retry; step the clock past the longest
            // backoff and let that timer run, as production would. 10 steps stay
            // inside the 6h expiry, so this exercises the budget, not the clock.
            for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
                clock.advance(LONGEST_BACKOFF_MS + 60_000);
                await until(async () => sender.calls.length === i + 1, `attempt ${i + 1}`);
                // Advancing before the retry timer is armed would put it in the
                // past of a clock that never moves again.
                await until(
                    async () =>
                        clock.pending === 1 || (await deliveryOf(store, id))?.status !== "pending",
                    `retry after attempt ${i + 1} armed`,
                );
            }
            const d = await deliveryOf(store, id);
            assert.equal(d?.status, "retryExhausted");
            assert.equal(d?.lastError, "net");
            assert.equal(sender.calls.length, MAX_DELIVERY_ATTEMPTS);
        });

        it("stops at once on a permanent failure, without burning the budget", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push({ kind: "permanentFailure", code: "no_context" });
            await deliverer.deliver(id);
            const d = await deliveryOf(store, id);
            assert.equal(d?.status, "permanentFailure");
            assert.equal(d?.lastError, "no_context");
            assert.equal(sender.calls.length, 1);
        });

        it("an unavailable channel waits without counting an attempt", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 3; i++) {
                sender.script.push({ kind: "unavailable", code: "not_connected" });
                await deliverer.deliver(id);
            }
            const d = await deliveryOf(store, id);
            assert.equal(d?.status, "pending", "an outage never exhausts the budget");
            assert.equal(d?.attempts, 0);
            assert.equal(clock.pending, 1, "only the expiry deadline is armed");
            assert.equal(sender.calls.length, MAX_DELIVERY_ATTEMPTS + 3, "no timer-driven resend");
        });

        it("probes an unavailable channel again on a slow timer", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push({ kind: "unavailable", code: "auth" });
            sender.script.push({ kind: "unavailable", code: "auth" });
            await deliverer.deliver(id);
            assert.equal(sender.calls.length, 1);
            clock.advance(UNAVAILABLE_RETRY_MS + 1);
            await until(
                async () => sender.calls.length === 2,
                "the next probe without a reconnect",
            );
            assert.equal((await deliveryOf(store, id))?.status, "pending");
            assert.equal(clock.pending, 1, "the next probe is armed");
        });

        it("a channel that never comes back still lets the notice expire", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push({ kind: "unavailable", code: "not_connected" });
            await deliverer.deliver(id);
            clock.advance(DELIVERY_EXPIRY_MS + 2);
            await until(
                async () => (await deliveryOf(store, id))?.status === "expired",
                "expiry without any other trigger",
            );
            assert.equal(sender.calls.length, 1, "expiring does not send");
        });

        it("a pending delivery is sent once the channel is back", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            sender.script.push({ kind: "unavailable", code: "not_connected" });
            await deliverer.deliver(id);
            await deliverer.resume();
            const d = await deliveryOf(store, id);
            assert.equal(d?.status, "confirmed");
        });
    });

    describe("expiry", () => {
        it("drops a notice that would be sent too long after the work ended", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            clock.advance(DELIVERY_EXPIRY_MS + 1);
            await deliverer.deliver(id);
            assert.equal(sender.calls.length, 0);
            assert.equal((await deliveryOf(store, id))?.status, "expired");
        });

        it("still sends one that is just inside the window", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            clock.advance(DELIVERY_EXPIRY_MS - 1);
            await deliverer.deliver(id);
            assert.equal(sender.calls.length, 1);
        });
    });

    describe("waiting for the parent model's reply", () => {
        it("sends nothing while the grace period is open", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                chunks: undefined,
                templateChunks: ["template"],
                awaitingParentReplyUntil: clock.time + PARENT_REPLY_GRACE_MS,
            });
            await deliverer.deliver(id);
            assert.equal(sender.calls.length, 0);
            assert.equal(clock.pending, 1);
        });

        it("falls back to the template once the grace period passes", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                chunks: undefined,
                templateChunks: ["template"],
                awaitingParentReplyUntil: clock.time + PARENT_REPLY_GRACE_MS,
            });
            await deliverer.deliver(id);
            clock.advance(PARENT_REPLY_GRACE_MS + 1);
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the template to be sent",
            );
            assert.deepEqual(
                sender.calls.map((c) => c.text),
                ["template"],
            );
            const d = await deliveryOf(store, id);
            assert.equal(d?.source, "template");
            assert.equal(d?.status, "confirmed");
        });

        it("a notice run still writing past the grace period keeps the template back", async () => {
            const clock = new FakeClock();
            const sender = new FakeSender();
            const store = new WorkStore(join(root, `s${seq++}`));
            const capturing = new Set<string>();
            const deliverer = new WorkDeliverer(store, sender, clock, undefined, {
                isCapturing: (id) => capturing.has(id),
            });
            const id = await seed(store, clock, {
                chunks: undefined,
                templateChunks: ["template"],
                awaitingParentReplyUntil: clock.time + PARENT_REPLY_GRACE_MS,
            });
            capturing.add(id);
            await deliverer.deliver(id);
            clock.advance(PARENT_REPLY_GRACE_MS + 1);
            await until(async () => clock.pending === 1, "the outer deadline to be armed");
            assert.equal(sender.calls.length, 0, "the run may still be waiting on an approval");
            assert.equal((await deliveryOf(store, id))?.chunks, undefined, "nothing frozen yet");

            clock.advance(PARENT_REPLY_MAX_WAIT_MS);
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the template after the outer bound",
            );
            assert.deepEqual(
                sender.calls.map((c) => c.text),
                ["template"],
            );
            assert.equal(
                capturing.has(id),
                true,
                "the late notice reply remains suppressed until its run ends",
            );
        });

        it("a reply frozen in time wins over the template", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                chunks: undefined,
                templateChunks: ["template"],
                awaitingParentReplyUntil: clock.time + PARENT_REPLY_GRACE_MS,
            });
            await store.mutate(id, (w) => ({
                ...w,
                delivery: {
                    ...(w.delivery as WorkDelivery),
                    chunks: ["the model's words"],
                    source: "parentReply" as const,
                    awaitingParentReplyUntil: undefined,
                },
            }));
            await deliverer.deliver(id);
            assert.deepEqual(
                sender.calls.map((c) => c.text),
                ["the model's words"],
            );
        });
    });

    describe("manual retry", () => {
        it("re-sends a notice that gave up, resuming at the next unconfirmed chunk", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                chunks: ["a", "b", "c"],
                status: "retryExhausted",
                confirmedChunks: 1,
                attempts: MAX_DELIVERY_ATTEMPTS,
                lastError: "net",
            });
            assert.equal(await deliverer.retry(id), "accepted");
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the retried delivery to finish",
            );
            assert.deepEqual(
                sender.calls.map((c) => c.text),
                ["b", "c"],
                "chunk a was already accepted and is not sent again",
            );
            const d = await deliveryOf(store, id);
            assert.equal(d?.attempts, 0);
            assert.equal(d?.lastError, undefined);
        });

        it("lets an expired notice be sent: the six hours restart at the retry", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                status: "expired",
                lastError: "notice too old to send",
            });
            clock.advance(DELIVERY_EXPIRY_MS * 3);
            assert.equal(await deliverer.retry(id), "accepted");
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the old notice to be sent rather than expired again",
            );
            assert.equal(sender.calls.length, 1);
        });

        it("refuses a permanent failure: the frozen target would fail the same way", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, {
                status: "permanentFailure",
                lastError: "no_context",
            });
            assert.equal(await deliverer.retry(id), "not_retryable");
            assert.equal(sender.calls.length, 0);
            assert.equal((await deliveryOf(store, id))?.status, "permanentFailure");
        });

        it("refuses anything that is still going or already done, so nothing is sent twice", async () => {
            for (const status of ["pending", "confirmed", "handedOff", "cancelled"] as const) {
                const { clock, sender, store, deliverer } = rig();
                const id = await seed(store, clock, { status });
                assert.equal(await deliverer.retry(id), "not_retryable", status);
                assert.equal(sender.calls.length, 0, status);
                assert.equal((await deliveryOf(store, id))?.status, status, status);
            }
        });

        it("two simultaneous retries send once", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, { status: "retryExhausted" });
            const [a, b] = await Promise.all([deliverer.retry(id), deliverer.retry(id)]);
            assert.deepEqual([a, b].sort(), ["accepted", "not_retryable"]);
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "delivery to finish",
            );
            assert.equal(sender.calls.length, 1);
        });

        it("reports not_found only for an unknown Work; one with no notice is not_retryable", async () => {
            const { clock, store, deliverer } = rig();
            assert.equal(await deliverer.retry("w-missing"), "not_found");
            const id = await seed(store, clock, {}, { delivery: undefined });
            assert.equal(await deliverer.retry(id), "not_retryable");
        });
    });

    describe("single sender", () => {
        it("two simultaneous triggers produce one send, not two", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            await Promise.all([deliverer.deliver(id), deliverer.deliver(id), deliverer.resume()]);
            assert.equal(sender.calls.length, 1);
        });

        it("replays a trigger that arrived while a delivery was mid-send", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            // Hold the first send open so a second trigger provably lands mid-run.
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const original = sender.sendText.bind(sender);
            let calls = 0;
            sender.sendText = async (channelId, route, text) => {
                calls++;
                if (calls === 1) {
                    sender.script.push({ kind: "unavailable", code: "not_connected" });
                    await gate;
                }
                return original(channelId, route, text);
            };

            const first = deliverer.deliver(id);
            await until(() => calls === 1, "the first send to start");
            // The trigger that used to be swallowed by the running guard.
            void deliverer.deliver(id);
            release();
            await first;
            await until(
                async () => (await deliveryOf(store, id))?.status === "confirmed",
                "the replayed send to run",
            );
            assert.equal(calls, 2);
        });

        it("a delivery that already finished is not sent again", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock);
            await deliverer.deliver(id);
            await deliverer.deliver(id);
            await deliverer.resume();
            assert.equal(sender.calls.length, 1);
        });
    });

    describe("restart", () => {
        it("resume() caps how many deliveries run at once", async () => {
            const { clock, store } = rig();
            const ids = await Promise.all(Array.from({ length: 20 }, () => seed(store, clock)));
            const sender = new FakeSender();
            const original = sender.sendText.bind(sender);
            let inFlight = 0;
            let maxInFlight = 0;
            sender.sendText = async (channelId, route, text) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 1));
                const out = await original(channelId, route, text);
                inFlight--;
                return out;
            };
            const deliverer = new WorkDeliverer(store, sender, clock);
            await deliverer.resume();
            assert.ok(maxInFlight <= 8, `at most 8 at once, saw ${maxInFlight}`);
            assert.equal(sender.calls.length, ids.length);
        });

        it("a new deliverer over the same store resumes at the next unconfirmed chunk", async () => {
            const { clock, sender, store, deliverer } = rig();
            const id = await seed(store, clock, { chunks: ["a", "b", "c"] });
            sender.script.push(confirmed, retryable());
            await deliverer.deliver(id);
            deliverer.stop();

            const sender2 = new FakeSender();
            const reborn = new WorkDeliverer(store, sender2, clock);
            clock.advance(FIRST_BACKOFF_MS + 1);
            await reborn.resume();
            assert.deepEqual(
                sender2.calls.map((c) => c.text),
                ["b", "c"],
            );
        });

        it("resume() leaves finished deliveries alone", async () => {
            const { clock, sender, store, deliverer } = rig();
            await seed(store, clock, { status: "confirmed", confirmedChunks: 1 });
            await seed(store, clock, { status: "handedOff" });
            await deliverer.resume();
            assert.equal(sender.calls.length, 0);
        });
    });

    it("stop() prevents any further send", async () => {
        const { clock, sender, store, deliverer } = rig();
        const id = await seed(store, clock);
        deliverer.stop();
        await deliverer.deliver(id);
        assert.equal(sender.calls.length, 0);
    });

    describe("backoffDelay", () => {
        it("stays within the jitter band and grows with the attempt", () => {
            for (let attempt = 0; attempt < DELIVERY_BACKOFF_MS.length; attempt++) {
                const base = DELIVERY_BACKOFF_MS[attempt] ?? LONGEST_BACKOFF_MS;
                assert.ok(backoffDelay(attempt, 0) >= base * 0.8 - 1);
                assert.ok(backoffDelay(attempt, 1) <= base * 1.2 + 1);
            }
            assert.ok(backoffDelay(1, 0.5) > backoffDelay(0, 0.5));
        });

        it("repeats the last delay beyond the table", () => {
            const last = LONGEST_BACKOFF_MS;
            assert.equal(backoffDelay(50, 0.5), last);
        });
    });
});
