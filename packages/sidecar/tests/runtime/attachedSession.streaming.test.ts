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
import { JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core";
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

    /**
     * The case D1 exists for. A run interrupted by a killed process stays in
     * the lane's `state.operation`, which is the same slot `lane.prompt()`
     * rejects on — so without resume the session is permanently unusable, and
     * a restart does not help because the operation is durable.
     *
     * Proven directly here rather than asserted on a stub: the first attach is
     * abandoned mid-prompt (session closed under the running turn), then a
     * second `AttachedSession.create` over the same session must recover on its
     * own and accept a fresh prompt.
     */
    it("resumes an operation interrupted by a killed process, so the lane accepts prompts again", async () => {
        const env = new NodeExecutionEnv({ cwd: tmp });
        const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(tmp, "sessions") });
        // A *paced* provider is what makes this deterministic. With
        // `tokensPerSecond: 0` the reply lands in one tick and the run settles
        // before the close, leaving nothing open (measured: only a 1-3ms window
        // produced an open operation, i.e. a flaky test). Pacing the stream
        // keeps the run mid-flight for the whole interrupt (measured: 5/5).
        const faux = fauxProvider({ provider: "faux", tokensPerSecond: 2 } as never);
        const models = createModels();
        models.setProvider(faux.provider);
        const id = uuidv7();
        const longReply = "a fairly long reply with many tokens to pace out";

        const build = async (session: unknown) =>
            await AttachedSession.create({
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

        // First attach: start a turn and close the session while the stream is
        // still being paced out. Awaiting the prompt is pointless — the point is
        // that it never completes, which is what a killed process looks like.
        faux.setResponses([fauxAssistantMessage([fauxText(longReply)])] as never);
        const first = await repo.create({ id, cwd: tmp }, harnessContext);
        const attached1 = await build(first);
        const abandoned = attached1.prompt("go", undefined, undefined).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await first.close(harnessContext).catch(() => undefined);
        await abandoned;

        // Second attach over the same session: create() reports the open
        // operation and AttachedSession resumes it in the background.
        const list = await repo.list(undefined, harnessContext);
        const meta = list.find((m) => m.id === id);
        assert.ok(meta, "the interrupted session should still be listed");
        // Queue both replies up front: one for the resumed run, one for the
        // prompt below. Setting them one at a time races the resume, which
        // starts as soon as `create()` returns and consumes the head of the
        // queue.
        faux.setResponses([
            fauxAssistantMessage([fauxText("recovered")]),
            fauxAssistantMessage([fauxText("second")]),
        ] as never);
        const attached2 = await build(await repo.open(meta, harnessContext));
        try {
            assert.equal(
                attached2.resumableOperations.length,
                1,
                "the interrupted run should be reported as open",
            );

            // The assertion that matters: this same call fails with LaneBusy
            // while the recovered operation still occupies the lane, so it only
            // succeeds because `prompt` waits for recovery to settle first.
            const reply = await attached2.prompt("again", undefined, undefined);
            assert.equal(reply.role, "assistant");
        } finally {
            await attached2.dispose();
        }
    });

    it("starts with an empty resumableOperations array on a fresh session", async () => {
        // pi's `AgentHarness.create()` returns the open[] array — durable
        // operations left in flight by a previous process. A fresh session over
        // a faux provider consumes its only response and settles, so the
        // array must be empty. The field is kept internal for structured
        // logging; a non-empty default would mean every attach logs a spurious
        // "interrupted operations" warning.
        const attached = await makeAttached("once");
        try {
            assert.deepEqual(attached.resumableOperations, []);
        } finally {
            await attached.dispose();
        }
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
