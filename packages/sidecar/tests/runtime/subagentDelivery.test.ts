/**
 * deliverSubagentResult — the prompt→busy→followUp→retry delivery sequence
 * used to hand a background subagent's result back to its parent session.
 *
 * Exercised against a fake `AttachedSession`-shaped object rather than a real
 * harness: the function only calls `prompt()` / `enqueue()` on whatever
 * `SessionRegistry.getAttached` returns, so a minimal stub is enough to
 * observe the three branches.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { LaneBusy } from "../../src/runtime/pi/values.ts";
import type { SessionRegistry } from "../../src/runtime/session/sessionRegistry.ts";
import { deliverSubagentResult } from "../../src/runtime/subagent/subagentDelivery.ts";

function laneBusy(): LaneBusy {
    return new LaneBusy({
        lane: "test-lane",
        operationId: "op-1",
        operationKind: "run",
        message: "lane busy",
    });
}

type FakeAttached = {
    prompt: (text: string) => Promise<void>;
    enqueue: (
        kind: "followUp",
        text: string,
    ) => Promise<{ mode: "queued"; entryId: string } | { mode: "idle" }>;
};

function registryFor(attached: FakeAttached | undefined): SessionRegistry {
    return {
        getAttached: () => attached as never,
    } as unknown as SessionRegistry;
}

describe("deliverSubagentResult", () => {
    const parentSessionId = asSessionId("parent-1");

    it("does nothing when the parent session is not attached", async () => {
        const registry = registryFor(undefined);
        await deliverSubagentResult(registry, parentSessionId, "hello");
        // No throw is the assertion — there is nothing else to observe.
    });

    it("delivers directly via prompt() when the parent is idle", async () => {
        let promptedWith: string | undefined;
        const attached: FakeAttached = {
            prompt: async (text) => {
                promptedWith = text;
            },
            enqueue: async () => {
                throw new Error("must not be called on the direct-success path");
            },
        };
        await deliverSubagentResult(registryFor(attached), parentSessionId, "result text");
        assert.equal(promptedWith, "result text");
    });

    it("falls back to enqueue(followUp) when prompt() rejects busy, then stops on queued and retries once on idle", async () => {
        for (const outcome of [
            {
                enqueueResult: { mode: "queued", entryId: "e1" } as const,
                expectedPromptCalls: 1,
                message: "must attempt prompt() once before falling back",
            },
            {
                enqueueResult: { mode: "idle" } as const,
                expectedPromptCalls: 2,
                message: "busy then idle-on-enqueue must trigger exactly one retry",
            },
        ]) {
            let promptCalls = 0;
            let enqueuedWith: string | undefined;
            const attached: FakeAttached = {
                prompt: async () => {
                    promptCalls++;
                    if (promptCalls === 1) throw laneBusy();
                    // Second call (the retry) succeeds.
                },
                enqueue: async (_kind, text) => {
                    enqueuedWith = text;
                    return outcome.enqueueResult;
                },
            };
            await deliverSubagentResult(registryFor(attached), parentSessionId, "notify me");
            assert.equal(promptCalls, outcome.expectedPromptCalls, outcome.message);
            assert.equal(enqueuedWith, "notify me");
        }
    });

    it("propagates a non-busy error from prompt() instead of swallowing it", async () => {
        const attached: FakeAttached = {
            prompt: async () => {
                throw new Error("boom");
            },
            enqueue: async () => {
                throw new Error("must not be called for a non-busy failure");
            },
        };
        await assert.rejects(
            deliverSubagentResult(registryFor(attached), parentSessionId, "x"),
            /boom/,
        );
    });
});
