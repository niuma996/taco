/**
 * runAttachedSubagent — progress emission + turn cap.
 *
 * The runner drives a real child harness in production; these cases run it
 * against a fake `attached` so the emission contract is pinned without a model:
 *  - the started update is checkpointed and carries the child's session id in
 *    `content` — pi shows checkpoint content to the model only when the call is
 *    interrupted, and that id is the handle `agentContinue` needs.
 *  - each completed turn publishes a live (non-checkpointed) update, sourced
 *    from the `turn_end` event's own assistant message (no session read).
 *  - the checkpoint's resume guidance follows `resumability`, so a skill
 *    subagent is not told to call agentContinue on an agentType that the agent
 *    registry cannot resolve.
 *  - a run that hits maxTurns aborts and degrades to a partial answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import type { AgentToolResult } from "../../src/runtime/pi/types.ts";
import { runAttachedSubagent } from "../../src/runtime/subagent/subagentRunner.ts";

interface Captured {
    text: string;
    details: unknown;
    checkpoint: boolean;
}

/**
 * Minimal AttachedSession stand-in: the runner only registers an event listener,
 * drives prompt(), and calls abort(). `prompt` stays pending until the test
 * releases it (or aborts), so turn events can be emitted mid-run.
 */
class FakeAttached {
    private readonly listeners = new Set<(event: unknown) => void>();
    private releasePrompt!: () => void;
    private readonly promptGate = new Promise<void>((resolve) => {
        this.releasePrompt = resolve;
    });
    aborted = false;

    on(_name: string, handler: (event: unknown) => void): void {
        this.listeners.add(handler);
    }

    off(_name: string, handler: (event: unknown) => void): void {
        this.listeners.delete(handler);
    }

    emit(event: unknown): void {
        for (const handler of [...this.listeners]) handler(event);
    }

    async prompt(): Promise<void> {
        await this.promptGate;
        if (this.aborted) throw new Error("Operation aborted");
    }

    async abort(): Promise<void> {
        this.aborted = true;
        this.releasePrompt();
    }

    /** Finish the run without aborting (child completed normally). */
    release(): void {
        this.releasePrompt();
    }

    asSession(): AttachedSession {
        return this as unknown as AttachedSession;
    }
}

/** Collect onUpdate calls as readable text + checkpoint flag. */
function collect(): {
    updates: Captured[];
    onUpdate: (partial: AgentToolResult<never>, options?: { checkpoint?: true }) => void;
} {
    const updates: Captured[] = [];
    return {
        updates,
        onUpdate: (partial, options) => {
            const text = partial.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
            updates.push({
                text,
                details: partial.details as unknown,
                checkpoint: options?.checkpoint === true,
            });
        },
    };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A `turn_end` event carrying one assistant text part, as pi emits it. */
const turnEnd = (text: string): unknown => ({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
});

const finalText = async (): Promise<{ text: string; isEmpty: boolean }> => ({
    text: "final answer",
    isEmpty: false,
});

describe("runAttachedSubagent — progress", () => {
    it("checkpoints the child session id before the child runs", async () => {
        const attached = new FakeAttached();
        const { updates, onUpdate } = collect();
        const run = runAttachedSubagent({
            subSessionId: asSessionId("sub-1"),
            attached: attached.asSession(),
            prompt: "go",
            agentType: "explorer",
            resumability: "resumable",
            onUpdate,
            readLastAssistantText: finalText,
        });
        // Published synchronously, before any await: a crash right after the
        // spawn still leaves the recovery handle in the transcript.
        assert.equal(updates.length, 1);

        attached.release();
        const result = await run;

        assert.equal(updates[0]?.checkpoint, true);
        assert.match(updates[0]?.text ?? "", /sub-1/);
        assert.deepEqual(updates[0]?.details, { subSessionId: "sub-1", agentType: "explorer" });
        assert.match(updates[0]?.text ?? "", /agentContinue/);
        assert.equal(result.resultText, "final answer");
        assert.equal(result.isError, false);
    });

    it("publishes one live update per completed turn, taken from the event itself", async () => {
        const attached = new FakeAttached();
        const { updates, onUpdate } = collect();
        let reads = 0;
        const run = runAttachedSubagent({
            subSessionId: asSessionId("sub-2"),
            attached: attached.asSession(),
            prompt: "go",
            agentType: "coder",
            resumability: "resumable",
            onUpdate,
            readLastAssistantText: async () => {
                reads++;
                return { text: "final answer", isEmpty: false };
            },
        });

        attached.emit(turnEnd("still working on it"));
        attached.emit(turnEnd("second turn output"));
        attached.release();
        await run;
        await flush();

        assert.equal(updates.length, 3);
        assert.equal(updates[1]?.checkpoint, false);
        assert.match(updates[1]?.text ?? "", /turn 1/);
        assert.match(updates[1]?.text ?? "", /still working on it/);
        assert.match(updates[2]?.text ?? "", /second turn output/);
        assert.equal((updates[2]?.details as { turns?: number }).turns, 2);
        // Progress must not read the child's session: only the settle path does.
        assert.equal(reads, 1);
    });

    it("tells a non-resumable child to re-invoke instead of calling agentContinue", async () => {
        const attached = new FakeAttached();
        const { updates, onUpdate } = collect();
        const run = runAttachedSubagent({
            subSessionId: asSessionId("sub-4"),
            attached: attached.asSession(),
            prompt: "go",
            // `skill:<name>` has no agent-registry entry, so runResume would fail closed.
            agentType: "skill:refactor",
            resumability: "not_resumable",
            onUpdate,
            readLastAssistantText: finalText,
        });
        attached.release();
        await run;

        assert.equal(updates[0]?.checkpoint, true);
        assert.match(updates[0]?.text ?? "", /sub-4/);
        assert.doesNotMatch(updates[0]?.text ?? "", /agentContinue/);
        assert.match(updates[0]?.text ?? "", /cannot\s+be\s+resumed/);
    });

    it("aborts on the turn cap and returns the partial answer", async () => {
        const attached = new FakeAttached();
        const { updates, onUpdate } = collect();
        const run = runAttachedSubagent({
            subSessionId: asSessionId("sub-3"),
            attached: attached.asSession(),
            prompt: "go",
            agentType: "coder",
            maxTurns: 1,
            resumability: "resumable",
            onUpdate,
            readLastAssistantText: async () => ({ text: "half done", isEmpty: false }),
        });

        attached.emit(turnEnd("half done"));
        const result = await run;

        assert.equal(attached.aborted, true);
        assert.equal(result.isError, false);
        assert.match(result.resultText, /1-turn limit/);
        assert.match(result.resultText, /half done/);
        // Only the started update is durable; turn updates never checkpoint.
        assert.equal(updates.filter((u) => u.checkpoint).length, 1);
        assert.equal(updates[0]?.checkpoint, true);
    });
});
