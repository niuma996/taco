/**
 * throttleByContent — unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage, ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";

import { throttleByContent } from "../../src/tags/throttle.ts";

function userMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** A hook that always injects the same fixed message before the event's. */
function fixedHook(text: string): (event: ContextEvent) => ContextResult {
    return (event) => ({ messages: [userMsg(text), ...event.messages] });
}

describe("throttleByContent", () => {
    it("injects on first call, skips identical content on subsequent calls", async () => {
        const hook = throttleByContent(fixedHook("stable"));
        const ev = { messages: [userMsg("x")] } as ContextEvent;

        const first = await hook(ev);
        assert.ok(first, "first call should inject");
        assert.equal(first.messages.length, 2);

        const second = await hook(ev);
        assert.equal(second, undefined, "identical content should be skipped");

        const third = await hook(ev);
        assert.equal(third, undefined, "still skipped");
    });

    it("re-injects when the inner hook's content changes", async () => {
        let payload = "v1";
        const hook = throttleByContent((event) => ({
            messages: [userMsg(payload), ...event.messages],
        }));
        const ev = { messages: [] } as unknown as ContextEvent;

        assert.ok(await hook(ev), "first inject");
        assert.equal(await hook(ev), undefined, "same content skipped");

        payload = "v2";
        const changed = await hook(ev);
        assert.ok(changed, "changed content re-injected");

        assert.equal(await hook(ev), undefined, "v2 now stable → skipped");
    });

    it("forces re-injection after maxConsecutiveSkips", async () => {
        const hook = throttleByContent(fixedHook("stable"), { maxConsecutiveSkips: 2 });
        const ev = { messages: [] } as unknown as ContextEvent;

        assert.ok(await hook(ev), "call 1: inject");
        assert.equal(await hook(ev), undefined, "call 2: skip #1");
        assert.equal(await hook(ev), undefined, "call 3: skip #2");
        // Third consecutive skip would exceed the cap of 2 → force re-inject.
        assert.ok(await hook(ev), "call 4: forced re-inject");
        assert.equal(await hook(ev), undefined, "call 5: skip #1 again");
    });

    it("passes through (and does not record state) when inner hook is a no-op", async () => {
        let injectNext = false;
        const hook = throttleByContent((event) =>
            injectNext ? { messages: [userMsg("late"), ...event.messages] } : undefined,
        );
        const ev = { messages: [] } as unknown as ContextEvent;

        assert.equal(await hook(ev), undefined, "no-op passes through");

        injectNext = true;
        const injected = await hook(ev);
        assert.ok(injected, "injects once inner hook produces content");
    });

    it("keeps independent state across separate wrappers", async () => {
        const a = throttleByContent(fixedHook("A"));
        const b = throttleByContent(fixedHook("B"));
        const ev = { messages: [] } as unknown as ContextEvent;

        assert.ok(await a(ev));
        assert.ok(await b(ev), "b's first call is independent of a");
        assert.equal(await a(ev), undefined);
        assert.equal(await b(ev), undefined);
    });
});
