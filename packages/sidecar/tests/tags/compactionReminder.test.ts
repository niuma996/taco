/**
 * compactionReminder — unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage, ContextEvent } from "@earendil-works/pi-agent-core";

import { buildCompactionReminderHook } from "../../src/tags/compactionReminder.ts";

function userMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function firstText(msg: AgentMessage): string {
    const content = (msg as { content: { type: "text"; text: string }[] }).content;
    return content[0].text;
}

describe("buildCompactionReminderHook", () => {
    it("is a no-op until notify() is called", () => {
        const { hook } = buildCompactionReminderHook();
        const ev = { messages: [userMsg("x")] } as ContextEvent;
        assert.equal(hook(ev), undefined);
    });

    it("injects <compaction_reminder> exactly once after notify()", () => {
        const { hook, notify } = buildCompactionReminderHook();
        const ev = { messages: [userMsg("x")] } as ContextEvent;

        notify();
        const injected = hook(ev);
        assert.ok(injected, "fires after notify");
        assert.equal(injected.messages.length, 2);
        assert.match(firstText(injected.messages[0] as AgentMessage), /^<compaction_reminder>/);
        assert.match(firstText(injected.messages[0] as AgentMessage), /just compacted/);

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

    it("places the tag before the original messages AND mutates the input array in place", () => {
        const { hook, notify } = buildCompactionReminderHook();
        const userMsgRef = userMsg("real");
        const original = [userMsgRef];
        notify();
        const res = hook({ messages: original } as ContextEvent);
        assert.ok(res);
        // New contract: hook mutates `event.messages` in place (required by
        // pi-agent-core's last-writer-wins emitHook semantics) and returns
        // the same array reference.
        assert.equal(res.messages, original, "result.messages must be the same reference");
        assert.equal(original.length, 2, "input array must be mutated to length 2");
        assert.equal(original[1], userMsgRef);
    });
});
