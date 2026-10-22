// Hook tests: compaction reminder injection and content-based throttling.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ContextEvent, ContextResult } from "../../src/extensions/types.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { buildCompactionReminderHook } from "../../src/tags/compactionReminder.ts";
import { throttleByContent } from "../../src/tags/throttle.ts";

function compactionUserMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function firstText(msg: AgentMessage): string {
    const content = (msg as { content: { type: "text"; text: string }[] }).content;
    return content[0].text;
}

describe("buildCompactionReminderHook", () => {
    it("is a no-op until notify() is called", () => {
        const { hook } = buildCompactionReminderHook();
        const ev = { messages: [compactionUserMsg("x")] } as ContextEvent;
        assert.equal(hook(ev), undefined);
    });

    it("injects <compaction_reminder> exactly once after notify()", () => {
        const { hook, notify } = buildCompactionReminderHook();
        const ev = { messages: [compactionUserMsg("x")] } as ContextEvent;

        notify();
        const injected = hook(ev);
        assert.ok(injected?.messages, "fires after notify");
        assert.equal(injected.messages.length, 2);
        assert.match(firstText(injected.messages[1] as AgentMessage), /^\[system-event\]/);
        assert.match(firstText(injected.messages[1] as AgentMessage), /<compaction_reminder>/);
        assert.match(firstText(injected.messages[1] as AgentMessage), /just compacted/);
        assert.match(firstText(injected.messages[1] as AgentMessage), /trust the PINNED text/);

        // Second call without another notify → cleared.
        assert.equal(hook(ev), undefined, "fires only once per notify");
    });

    it("re-arms on each notify()", () => {
        const { hook, notify } = buildCompactionReminderHook();
        const ev = { messages: [] } as unknown as ContextEvent;

        notify();
        assert.ok(hook(ev));
        assert.equal(hook(ev), undefined);

        notify();
        assert.ok(hook(ev), "second notify re-arms");
        assert.equal(hook(ev), undefined);
    });

    it("keeps state isolated across separate instances (no cross-session leak)", () => {
        const a = buildCompactionReminderHook();
        const b = buildCompactionReminderHook();
        const ev = { messages: [] } as unknown as ContextEvent;

        // Arm only A. B must not consume A's flag.
        a.notify();
        assert.equal(b.hook(ev), undefined, "B not armed by A's notify");
        assert.ok(a.hook(ev), "A still fires its own reminder");
    });

    it("places the tag after the original messages AND mutates the input array in place", () => {
        const { hook, notify } = buildCompactionReminderHook();
        const userMsgRef = compactionUserMsg("real");
        const original = [userMsgRef];
        notify();
        const res = hook({ messages: original } as ContextEvent);
        assert.ok(res);
        assert.equal(res.messages, original, "result.messages must be the same reference");
        assert.equal(original.length, 2, "input array must be mutated to length 2");
        assert.equal(original[0], userMsgRef);
    });
});

function throttleUserMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** A hook that always injects the same fixed message before the event's. */
function fixedHook(text: string): (event: ContextEvent) => ContextResult {
    return (event) => ({ messages: [throttleUserMsg(text), ...event.messages] });
}

describe("throttleByContent", () => {
    it("injects on first call, skips identical content on subsequent calls", async () => {
        const hook = throttleByContent(fixedHook("stable"));
        const ev = { messages: [throttleUserMsg("x")] } as ContextEvent;

        const first = await hook(ev);
        assert.ok(first?.messages, "first call should inject");
        assert.equal(first.messages.length, 2);

        const second = await hook(ev);
        assert.equal(second, undefined, "identical content should be skipped");

        const third = await hook(ev);
        assert.equal(third, undefined, "still skipped");
    });

    it("re-injects when the inner hook's content changes", async () => {
        let payload = "v1";
        const hook = throttleByContent((event) => ({
            messages: [throttleUserMsg(payload), ...event.messages],
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
            injectNext ? { messages: [throttleUserMsg("late"), ...event.messages] } : undefined,
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
