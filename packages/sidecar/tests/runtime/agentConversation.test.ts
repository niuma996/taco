import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentChatResult } from "../../src/agents/agentConversationTypes.ts";
import type { SessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import {
    AgentConversation,
    type AgentMessageRecord,
} from "../../src/runtime/subagent/agentConversation.ts";

function fixture() {
    const facts = new Map<string, SessionFacts>([
        ["parent", {}],
        ["other", {}],
        ["a", { kind: "subagent", parentSessionId: "parent", agentType: "explorer" }],
        ["b", { kind: "subagent", parentSessionId: "parent", agentType: "explorer" }],
        ["foreign", { kind: "subagent", parentSessionId: "other", agentType: "explorer" }],
    ]);
    const records = new Map<string, AgentMessageRecord[]>();
    const delivered: AgentMessageRecord[] = [];
    const running = new Set<string>();
    let complete: (() => void) | undefined;
    const coordinator = new AgentConversation({
        readFacts: async (id) => {
            const result = facts.get(id);
            if (!result) throw new Error("session missing");
            return result;
        },
        readMessages: async (id) => structuredClone(records.get(id) ?? []),
        writeMessages: async (id, entries) => {
            records.set(id, structuredClone(entries));
        },
        isRunning: (id) => running.has(id),
        deliver: async (message) => {
            delivered.push(message);
            const result: AgentChatResult = {
                subSessionId: message.targetSessionId,
                messageId: message.messageId,
                status: "queued",
                effectiveDelivery: message.delivery,
                resultText: "accepted",
                isError: false,
            };
            if (message.background) return { result };
            return {
                result,
                completion: new Promise<AgentChatResult>((resolve) => {
                    complete = () =>
                        resolve({ ...result, status: "completed", resultText: "answer" });
                }),
            };
        },
    });
    const send = (
        caller: string,
        target: string,
        call: string,
        prompt = "hello",
        background = true,
    ) =>
        coordinator.chat(asSessionId(caller), {
            subSessionId: asSessionId(target),
            parentToolCallId: call,
            prompt,
            background,
        });
    return { coordinator, send, records, delivered, facts, running, finish: () => complete?.() };
}

describe("AgentConversation", () => {
    it("allows own children and siblings without changing their owner", async () => {
        const f = fixture();
        assert.equal((await f.send("parent", "a", "p1")).isError, false);
        assert.equal((await f.send("a", "b", "a1")).isError, false);
        assert.equal(f.delivered[1]?.ownerParentSessionId, "parent");
        assert.equal(f.delivered[1]?.relation, "peer");
    });

    it("rejects self and unrelated sessions before delivering", async () => {
        const f = fixture();
        for (const [caller, target] of [
            ["a", "a"],
            ["other", "a"],
            ["a", "foreign"],
            ["a", "parent"],
        ] as const) {
            assert.equal((await f.send(caller, target, "bad")).isError, true);
        }
        assert.equal(f.delivered.length, 0);
    });

    it("delivers distinct concurrent same-target messages and deduplicates invocation retries", async () => {
        const f = fixture();
        const [one, two] = await Promise.all([
            f.send("parent", "a", "1", "first"),
            f.send("parent", "a", "2", "second"),
        ]);
        assert.notEqual(one.messageId, two.messageId);
        assert.deepEqual(
            f.delivered.map((m) => m.prompt),
            ["first", "second"],
        );
        assert.equal((await f.send("parent", "a", "1", "first")).messageId, one.messageId);
        assert.equal(f.delivered.length, 2);
    });

    it("checks authorization again before returning an existing receipt", async () => {
        const f = fixture();
        await f.send("parent", "a", "1");
        f.facts.set("a", { kind: "subagent", parentSessionId: "other" });
        assert.equal((await f.send("parent", "a", "1")).isError, true);
    });

    it("rejects blocking sibling/running sends without delivering", async () => {
        const f = fixture();
        assert.equal((await f.send("a", "b", "1", "hello", false)).isError, true);
        f.running.add("a");
        assert.equal((await f.send("parent", "a", "2", "hello", false)).isError, true);
        assert.equal(f.delivered.length, 0);
    });

    it("releases admission while a synchronous parent waits for completion", async () => {
        const f = fixture();
        const answer = f.send("parent", "a", "1", "task", false);
        // A receipt is observable only after the short admission section has finished.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const interjection = await f.send("parent", "a", "2", "additional detail");
        assert.equal(interjection.isError, false);
        f.finish();
        assert.equal((await answer).resultText, "answer");
    });

    it("marks a crashed admission uncertain instead of blindly replaying it", async () => {
        const f = fixture();
        await f.send("parent", "a", "1");
        const entry = f.records.get("a")?.[0];
        assert.ok(entry);
        entry.receipt = undefined;
        const retry = await f.send("parent", "a", "1");
        assert.equal(retry.isError, true);
        assert.match(retry.resultText, /uncertain/);
        assert.equal(f.delivered.length, 1);
    });

    it("permits reply correlation only for a message received from that target", async () => {
        const f = fixture();
        const initial = await f.send("a", "b", "1");
        const reply = await f.coordinator.chat(asSessionId("b"), {
            subSessionId: asSessionId("a"),
            parentToolCallId: "2",
            prompt: "answer",
            inReplyTo: initial.messageId,
        });
        assert.equal(reply.isError, false);
        const forged = await f.coordinator.chat(asSessionId("b"), {
            subSessionId: asSessionId("a"),
            parentToolCallId: "3",
            prompt: "answer",
            inReplyTo: "unknown",
        });
        assert.equal(forged.isError, true);
    });
});
