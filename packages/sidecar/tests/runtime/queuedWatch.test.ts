/**
 * The queue watcher: a scheduled fire that had to queue its prompt learns
 * whether the entry ran. These cases are the ones a naive "enqueue means
 * done" record got wrong — an entry cleared by a stop, and an entry consumed
 * before the dispatcher could even subscribe.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createQueuedWatch } from "../../src/runtime/harness/queuedWatch.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";

const assistant = (text: string) =>
    ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AgentMessage;

function rig() {
    const attached = new EventEmitter();
    const lifecycle = new EventEmitter();
    const watch = createQueuedWatch(
        lifecycle as unknown as Parameters<typeof createQueuedWatch>[0],
        attached as unknown as Parameters<typeof createQueuedWatch>[1],
        "s-1",
    );
    return {
        watch,
        emit: (event: unknown) => attached.emit("event", event),
        detach: () => lifecycle.emit("session.detached", { sessionId: "s-1" }),
    };
}

const queued = (ids: string[]) => ({
    type: "queue_update",
    queues: ids.map((entryId) => ({ entryId, kind: "followUp" })),
});

describe("queued watch", () => {
    it("answers with the reply of the run that consumed the entry", async () => {
        const { watch, emit } = rig();
        const pending = watch.wait("e-1");
        emit(queued(["e-1"]));
        emit({ type: "run_start", runId: "r" });
        emit({ type: "message_end", entryId: "e-1", message: { role: "user", content: "hi" } });
        emit({ type: "queue_update", queues: [] });
        emit({ type: "message_end", message: assistant("done") });
        emit({ type: "run_end", status: "completed" });
        assert.deepEqual(await pending, { kind: "answered", message: assistant("done") });
    });

    it("drops an entry a stop cleared before it ran", async () => {
        const { watch, emit } = rig();
        const pending = watch.wait("e-1");
        emit(queued(["e-1"]));
        emit({ type: "queue_update", queues: [] });
        assert.deepEqual(await pending, { kind: "dropped" });
    });

    it("reports a run stopped after consuming the entry as aborted", async () => {
        const { watch, emit } = rig();
        const pending = watch.wait("e-1");
        emit(queued(["e-1"]));
        emit({ type: "message_end", entryId: "e-1", message: { role: "user", content: "hi" } });
        emit({ type: "run_end", status: "aborted" });
        assert.deepEqual(await pending, { kind: "aborted" });
    });

    it("drops everything when the session goes away", async () => {
        const { watch, emit, detach } = rig();
        const pending = watch.wait("e-1");
        emit(queued(["e-1"]));
        detach();
        assert.deepEqual(await pending, { kind: "dropped" });
    });

    it("resolves immediately when the events arrived before the wait", async () => {
        // The enqueue's own snapshot lands while the prompt RPC is still in
        // flight; subscribing after it must not lose the entry.
        const { watch, emit } = rig();
        emit(queued(["e-1"]));
        emit({ type: "message_end", entryId: "e-1", message: { role: "user", content: "hi" } });
        const pending = watch.wait("e-1");
        emit({ type: "message_end", message: assistant("late") });
        emit({ type: "run_end", status: "completed" });
        assert.deepEqual(await pending, { kind: "answered", message: assistant("late") });
    });

    it("sees a cleared entry that was cleared before the wait", async () => {
        const { watch, emit } = rig();
        emit(queued(["e-1"]));
        emit({ type: "queue_update", queues: [] });
        assert.deepEqual(await watch.wait("e-1"), { kind: "dropped" });
    });

    it("stops listening after stop()", async () => {
        const { watch, emit } = rig();
        const pending = watch.wait("e-1");
        watch.stop();
        emit(queued(["e-1"]));
        assert.deepEqual(await pending, { kind: "dropped" });
    });
});
