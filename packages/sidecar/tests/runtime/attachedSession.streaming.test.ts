/**
 * AttachedSession turn behaviour, driven by a real harness over a faux provider.
 *
 * Both cases here need a real harness rather than event fixtures:
 *
 *  - Streaming: pi 0.85 emits the streamed sub-event under a different name than
 *    its own .d.ts declares, so a fixture written from the declaration is wrong
 *    in exactly the way the product was wrong — it passes while the UI shows the
 *    whole reply at once. (The pre-existing applyEventToMessages test did.)
 *  - A run that fails without a reply: the interesting value is the operation
 *    record pi writes, which only exists when a real run terminates.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/attachedSession.ts";
import { normalizeMessageUpdate } from "../../src/server/push.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";

/** Sub-event shape the desktop renderer reads off a normalized frame. */
interface SubEvent {
    type?: string;
    delta?: string;
}

let tmp: string;

before(() => {
    tmp = mkdtempSync(join(tmpdir(), "taco-streaming-"));
});

after(() => {
    rmSync(tmp, { recursive: true, force: true });
});

/** Build an AttachedSession over a faux provider. `register: false` leaves the
 *  provider out of the model registry, which makes the run fail with
 *  `model_unavailable` — the cheapest way to reach a terminal non-success run. */
async function makeAttached(reply: string, register = true) {
    const env = new NodeExecutionEnv({ cwd: tmp });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(tmp, "sessions") });
    // tokensPerSecond: 0 removes the pacing delay — the deltas still arrive as
    // separate events, the test just does not wait out a simulated token rate.
    const faux = fauxProvider({ provider: "faux", tokensPerSecond: 0 } as never);
    faux.setResponses([fauxAssistantMessage([fauxText(reply)])] as never);
    const models = createModels();
    if (register) models.setProvider(faux.provider);

    const session = await repo.create({ cwd: tmp }, harnessContext);
    const attached = await AttachedSession.create({
        session,
        models,
        model: faux.getModel(),
        env,
        systemPrompt: "test",
        tools: [],
        resources: {},
        streamOptions: {},
        taskStore: {
            lists: new Map(),
            getTaskState: () => ({ planMode: false, currentTask: undefined }),
            setTaskState: () => {},
        } as unknown as TaskStore,
        planState: createPlanModeState(),
        tasksDir: tmp,
        sessionCwd: tmp as never,
        getToolContext: () => ({ env, workspace: tmp as never }) as never,
    } as never);

    return attached;
}

/** Stream `reply` through a real harness; return every republished event. */
async function runStreamingTurn(reply: string): Promise<Array<Record<string, unknown>>> {
    const attached = await makeAttached(reply);
    const events: Array<Record<string, unknown>> = [];
    attached.on("event", (ev: Record<string, unknown>) => events.push(ev));
    try {
        await attached.prompt("hi", undefined, undefined);
        return events;
    } finally {
        await attached.dispose();
    }
}

describe("AttachedSession — streaming a turn", () => {
    it("republishes incremental message_update events, not just the final message", async () => {
        const events = await runStreamingTurn("hello streaming world");
        const updates = events.filter((e) => e.type === "message_update");
        assert.ok(
            updates.length > 0,
            `expected incremental updates, got only: ${events.map((e) => e.type).join(", ")}`,
        );
    });

    it("carries the streamed deltas under the field clients read", async () => {
        const events = await runStreamingTurn("hello streaming world");
        const subs = events
            .filter((e) => e.type === "message_update")
            .map(
                (e) =>
                    (normalizeMessageUpdate(e) as { assistantMessageEvent?: SubEvent })
                        .assistantMessageEvent,
            );

        assert.ok(
            subs.every((s) => s !== undefined),
            "a missing sub-event makes the renderer drop the delta and show the reply all at once",
        );
        // The concatenated deltas must reconstruct the reply — proof the UI can
        // build the text incrementally rather than waiting for message_end.
        const streamed = subs
            .filter((s) => s?.type === "text_delta")
            .map((s) => s?.delta ?? "")
            .join("");
        assert.equal(streamed, "hello streaming world");
    });
});

describe("AttachedSession.prompt — a run that fails without a reply", () => {
    it("reports the operation's own error, not the missing-reply symptom", async () => {
        // The run resolves ok:true (reaching a terminal state is not a call
        // failure) with status "failed" and the reason in record.error. Reading
        // the branch tip first finds the user message still there and reports
        // "expected an assistant reply, got role=user" — the symptom, with the
        // actual cause discarded.
        const attached = await makeAttached("unused", false);
        try {
            await assert.rejects(
                () => attached.prompt("hi", undefined, undefined),
                (error: Error & { code?: string }) => {
                    assert.match(error.message, /model_unavailable/);
                    assert.equal(
                        error.code,
                        "model_unavailable",
                        "code is carried for RPC mapping",
                    );
                    assert.doesNotMatch(
                        error.message,
                        /expected an assistant reply/,
                        "the symptom must not mask the cause",
                    );
                    return true;
                },
            );
        } finally {
            await attached.dispose();
        }
    });
});
