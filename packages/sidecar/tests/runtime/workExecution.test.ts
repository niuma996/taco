/**
 * Work lifecycle spike: the pi lane seams the Work plan depends on.
 *
 * These run against a real harness over a faux provider because the claims are
 * about pi's own behaviour (admission, idempotency, drive ownership, durable
 * results). A hand-written fixture would assert what we believe pi does.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import {
    type FauxProviderHandle,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { AgentHarness, JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";

const LANE = "main";

describe("work execution seam (pi lane)", () => {
    let tmp: string;

    before(() => {
        tmp = mkdtempSync(join(tmpdir(), "taco-work-exec-"));
    });

    after(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    interface Rig {
        faux: FauxProviderHandle;
        repo: JsonlSessionRepo;
        id: string;
        /** Attach a harness + lane over the (re)opened session. */
        attach(): Promise<{
            lane: Awaited<
                ReturnType<Awaited<ReturnType<typeof AgentHarness.create>>["harness"]["lane"]>
            >;
            harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
            open: Awaited<ReturnType<typeof AgentHarness.create>>["open"];
            session: Awaited<ReturnType<JsonlSessionRepo["create"]>>;
            close(): Promise<void>;
        }>;
    }

    function makeRig(options: { tokensPerSecond?: number; tools?: unknown[] } = {}): Rig {
        const env = new NodeExecutionEnv({ cwd: tmp });
        const repo = new JsonlSessionRepo({
            fileSystem: env,
            sessionsRoot: join(tmp, `sessions-${uuidv7()}`),
        });
        const faux = fauxProvider({
            provider: "faux",
            tokensPerSecond: options.tokensPerSecond ?? 0,
        } as never);
        const models = createModels();
        models.setProvider(faux.provider);
        const id = uuidv7();
        let created = false;

        const attach: Rig["attach"] = async () => {
            let session: Awaited<ReturnType<typeof repo.create>>;
            if (!created) {
                session = await repo.create({ id, cwd: tmp }, harnessContext);
                created = true;
            } else {
                const list = await repo.list(undefined, harnessContext);
                const meta = list.find((m) => m.id === id);
                assert.ok(meta, "session should be listed");
                session = await repo.open(meta, harnessContext);
            }
            const { harness, open } = await AgentHarness.create(
                {
                    session,
                    models,
                    model: faux.getModel(),
                    thinkingLevel: "off",
                    systemPrompt: "test",
                    tools: (options.tools ?? []) as never,
                    resources: {},
                    streamOptions: {},
                    toolContext: () => ({ env, workspace: tmp }) as never,
                } as never,
                harnessContext,
            );
            const lane = await harness.lane(LANE, { createAt: null }, harnessContext);
            return {
                lane,
                harness,
                open,
                session,
                close: async () => {
                    await session.close(harnessContext).catch(() => undefined);
                },
            } as never;
        };
        return { faux, repo, id, attach };
    }

    const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

    describe("accept / drive / getResult", () => {
        it("accept returns an operationId before the model finishes; drive settles the same operation", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([
                reply("a reasonably long reply so the run is observably in flight"),
            ] as never);
            const { lane, close } = await rig.attach();
            try {
                const admission = await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-1" },
                    harnessContext,
                );
                assert.ok(admission.ok, "accept should admit");
                assert.equal(admission.value.operationId, "op-1", "caller-supplied id is honoured");

                // Returned before the model produced the reply.
                const midFlight = await lane.inspectExecution(harnessContext);
                assert.equal(midFlight.current?.id, "op-1");
                assert.equal(await lane.getResult("op-1", harnessContext), undefined);

                const driven = await lane.drive({ operationId: "op-1" }, harnessContext);
                assert.ok(driven.ok);
                assert.equal(driven.value.kind, "settled");
                if (driven.value.kind === "settled") {
                    assert.equal(driven.value.outcome.operationId, "op-1");
                    assert.equal(driven.value.outcome.status, "completed");
                    assert.ok(driven.value.outcome.tipId);
                }

                const stored = await lane.getResult("op-1", harnessContext);
                assert.equal(stored?.status, "completed");
                const after = await lane.inspectExecution(harnessContext);
                assert.equal(after.current, null);
                assert.equal(after.lastOperationId, "op-1");
            } finally {
                await close();
            }
        });

        it("getResult survives closing and reopening the session", async () => {
            const rig = makeRig();
            rig.faux.setResponses([reply("durable")] as never);
            const first = await rig.attach();
            const admission = await first.lane.accept(
                { kind: "prompt", prompt: "go", operationId: "op-durable" },
                harnessContext,
            );
            assert.ok(admission.ok);
            const driven = await first.lane.drive({ operationId: "op-durable" }, harnessContext);
            assert.ok(driven.ok && driven.value.kind === "settled");
            await first.close();

            const second = await rig.attach();
            try {
                assert.deepEqual(second.open, [], "a settled run is not reported as open");
                const stored = await second.lane.getResult("op-durable", harnessContext);
                assert.equal(stored?.status, "completed");
                assert.equal(stored?.operationId, "op-durable");
                // drive on a settled id reads the stored result rather than re-running.
                const redriven = await second.lane.drive(
                    { operationId: "op-durable" },
                    harnessContext,
                );
                assert.ok(redriven.ok && redriven.value.kind === "settled");
                assert.equal(rig.faux.state.callCount, 1, "no second model call");
            } finally {
                await second.close();
            }
        });

        it("drive on an unknown operationId is an OperationMismatch, not a hang", async () => {
            const rig = makeRig();
            const { lane, close } = await rig.attach();
            try {
                const driven = await lane.drive({ operationId: "never-accepted" }, harnessContext);
                assert.equal(driven.ok, false);
                assert.equal(
                    (driven as { error: { _tag: string } }).error._tag,
                    "OperationMismatch",
                );
            } finally {
                await close();
            }
        });

        it("accept is NOT idempotent on a settled operationId (PROBE: records what pi does)", async () => {
            const rig = makeRig();
            rig.faux.setResponses([reply("first"), reply("second")] as never);
            const { lane, close } = await rig.attach();
            try {
                const a1 = await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-dup" },
                    harnessContext,
                );
                assert.ok(a1.ok);
                await lane.drive({ operationId: "op-dup" }, harnessContext);
                const firstResult = await lane.getResult("op-dup", harnessContext);
                assert.equal(firstResult?.status, "completed");

                const a2 = await lane.accept(
                    { kind: "prompt", prompt: "go again", operationId: "op-dup" },
                    harnessContext,
                );
                // The plan's guard (getResult before accept) exists because of this.
                assert.equal(
                    a2.ok,
                    true,
                    "pi re-admits a settled operationId: idempotency is the caller's job",
                );
                await lane.drive({ operationId: "op-dup" }, harnessContext);
                assert.equal(
                    rig.faux.state.callCount,
                    2,
                    "the repeated accept ran the model again",
                );
                const secondResult = await lane.getResult("op-dup", harnessContext);
                assert.notEqual(
                    secondResult?.tipId,
                    firstResult?.tipId,
                    "the stored result for the id was overwritten",
                );
            } finally {
                await close();
            }
        });

        it("a second accept while an operation is open is LaneBusy and names the live operation", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([
                reply("a reasonably long reply so the run stays open a while"),
            ] as never);
            const { lane, close } = await rig.attach();
            try {
                const a1 = await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-a" },
                    harnessContext,
                );
                assert.ok(a1.ok);
                const a2 = await lane.accept(
                    { kind: "prompt", prompt: "other work", operationId: "op-b" },
                    harnessContext,
                );
                assert.equal(a2.ok, false);
                const err = (a2 as { error: { _tag: string; operationId?: string } }).error;
                assert.equal(err._tag, "LaneBusy");
                assert.equal(err.operationId, "op-a", "busy error carries the live operation id");
                await lane.drive({ operationId: "op-a" }, harnessContext);
            } finally {
                await close();
            }
        });
    });
    /** Start a paced run, then close the session under it: what a killed process leaves behind. */
    async function abandonMidFlight(rig: Rig, operationId: string) {
        const first = await rig.attach();
        const admission = await first.lane.accept(
            { kind: "prompt", prompt: "go", operationId },
            harnessContext,
        );
        assert.ok(admission.ok);
        // Drive so the run actually streams, then cut the session off mid-stream.
        const driving = first.lane.drive({ operationId }, harnessContext).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 80));
        await first.close();
        await driving;
    }

    describe("restart: resume vs drive ownership", () => {
        const long = "a fairly long reply with many tokens to pace out for the interrupted run";

        it("an interrupted operation is reported open, has no result, and survives in inspectExecution", async () => {
            const rig = makeRig({ tokensPerSecond: 50 });
            rig.faux.setResponses([reply(long)] as never);
            await abandonMidFlight(rig, "op-crash");

            const second = await rig.attach();
            try {
                assert.equal(second.open.length, 1, "create() reports the open operation");
                assert.equal(second.open[0]?.operationId, "op-crash");
                assert.equal(await second.lane.getResult("op-crash", harnessContext), undefined);
                const info = await second.lane.inspectExecution(harnessContext);
                assert.equal(info.current?.id, "op-crash", "current survives the restart");
                // Settle it so the close below is clean.
                rig.faux.setResponses([reply("recovered")] as never);
                await second.lane.resume(harnessContext);
            } finally {
                await second.close();
            }
        });

        it("resume() and a concurrent drive() with the same wait options share one execution", async () => {
            const rig = makeRig({ tokensPerSecond: 50 });
            rig.faux.setResponses([reply(long)] as never);
            await abandonMidFlight(rig, "op-race");
            const callsBefore = rig.faux.state.callCount;

            const second = await rig.attach();
            try {
                rig.faux.setResponses([reply("recovered once")] as never);
                const [resumed, driven] = await Promise.all([
                    second.lane.resume(harnessContext),
                    second.lane.drive(
                        { operationId: "op-race", waitForRetry: true, pollDeferred: true },
                        harnessContext,
                    ),
                ]);
                assert.ok(resumed.ok, "resume ok");
                assert.ok(driven.ok && driven.value.kind === "settled", "drive settles");
                assert.equal(
                    rig.faux.state.callCount - callsBefore,
                    1,
                    "exactly one model call for the recovered run",
                );
                const stored = await second.lane.getResult("op-race", harnessContext);
                assert.equal(stored?.status, "completed");
            } finally {
                await second.close();
            }
        });

        // A concurrent bare drive() and resume() is NOT asserted here: whoever
        // installs the Drive wins, and the fault only appears when resume joins a
        // bare drive during its (microtask-short) retry-wait window. That race is
        // real — resume() then throws HarnessFault "returned an unwaited retry" —
        // but it cannot be ordered deterministically through the lane API, and a
        // test that fails one run in three teaches nothing. The rule it implies is
        // enforced by the test below: a reconciler must treat a bare drive()'s `ok`
        // as "still open", and never drive an operation attach recovery may resume.
        it("a bare drive() on an interrupted operation reports a retry wait instead of settling", async () => {
            const rig = makeRig({ tokensPerSecond: 50 });
            rig.faux.setResponses([reply(long)] as never);
            await abandonMidFlight(rig, "op-bare");

            const second = await rig.attach();
            try {
                rig.faux.setResponses([reply("driven")] as never);
                const driven = await second.lane.drive({ operationId: "op-bare" }, harnessContext);
                assert.ok(driven.ok);
                if (!driven.ok) return;
                // A not-yet-settled state, so a reconciler that treats any ok drive as
                // "finished" would record a running operation as done.
                assert.equal(driven.value.kind, "waiting");
                if (driven.value.kind === "waiting") assert.equal(driven.value.reason, "retry");
                assert.equal(await second.lane.getResult("op-bare", harnessContext), undefined);
                await second.lane.drive(
                    { operationId: "op-bare", waitForRetry: true },
                    harnessContext,
                );
            } finally {
                await second.close();
            }
        });

        it("drive({waitForRetry}) alone (no resume) is enough to finish an interrupted operation", async () => {
            const rig = makeRig({ tokensPerSecond: 50 });
            rig.faux.setResponses([reply(long)] as never);
            await abandonMidFlight(rig, "op-drive-only");

            const second = await rig.attach();
            try {
                rig.faux.setResponses([reply("driven")] as never);
                const driven = await second.lane.drive(
                    { operationId: "op-drive-only", waitForRetry: true },
                    harnessContext,
                );
                assert.ok(driven.ok && driven.value.kind === "settled");
                const info = await second.lane.inspectExecution(harnessContext);
                assert.equal(info.current, null, "lane is free again");
            } finally {
                await second.close();
            }
        });

        it("resume() after drive() settled the operation reports NothingToResume", async () => {
            const rig = makeRig();
            rig.faux.setResponses([reply("done")] as never);
            const { lane, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-x" },
                    harnessContext,
                );
                await lane.drive({ operationId: "op-x" }, harnessContext);
                const resumed = await lane.resume(harnessContext);
                assert.equal(resumed.ok, false);
                assert.equal(
                    (resumed as { error: { _tag: string } }).error._tag,
                    "NothingToResume",
                );
            } finally {
                await close();
            }
        });
    });

    describe("waiting: terminating tools", () => {
        const askUser = {
            name: "askUser",
            label: "askUser",
            description: "test stub",
            parameters: { type: "object", properties: {} },
            executionMode: "sequential",
            async execute() {
                return {
                    content: [{ type: "text", text: "ask first" }],
                    details: { questions: [], waiting: true },
                    terminate: true,
                };
            },
        };

        it("a run closing on a terminating toolResult settles completed and the tip is a terminate:true toolResult", async () => {
            const rig = makeRig({ tools: [askUser] });
            rig.faux.setResponses([
                fauxAssistantMessage([
                    fauxText("need to ask"),
                    { type: "toolCall", id: "tc-1", name: "askUser", arguments: {} },
                ]),
            ] as never);
            const { lane, session, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-ask" },
                    harnessContext,
                );
                const driven = await lane.drive({ operationId: "op-ask" }, harnessContext);
                assert.ok(driven.ok && driven.value.kind === "settled");
                if (driven.value.kind !== "settled") return;
                // "completed" does not mean "done": the plan must classify waiting
                // from the tip, not from the status.
                assert.equal(driven.value.outcome.status, "completed");
                const tipId = driven.value.outcome.tipId;
                assert.ok(tipId);
                const entry = await session.getEntry(tipId, harnessContext);
                assert.equal(entry?.type, "message");
                if (entry?.type !== "message") return;
                assert.equal(entry.terminate, true);
                assert.equal(entry.message.role, "toolResult");
                const tr = entry.message as { toolName?: string; toolCallId?: string };
                assert.equal(tr.toolName, "askUser");
                assert.equal(tr.toolCallId, "tc-1");
            } finally {
                await close();
            }
        });
    });

    describe("cancellation: requestAbort vs abort", () => {
        const long = "a fairly long reply with many tokens so the abort lands mid-stream";

        it("requestAbort(operationId) cancels the live operation and drive settles it aborted", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([reply(long)] as never);
            const { lane, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-cancel" },
                    harnessContext,
                );
                const driving = lane.drive({ operationId: "op-cancel" }, harnessContext);
                await new Promise((r) => setTimeout(r, 60));
                const requested = await lane.requestAbort("op-cancel", harnessContext);
                assert.ok(requested.ok, "requestAbort ok");
                if (requested.ok) assert.equal(requested.value.newlyRequested, true);
                const driven = await driving;
                assert.ok(driven.ok && driven.value.kind === "settled");
                if (driven.ok && driven.value.kind === "settled") {
                    assert.equal(driven.value.outcome.status, "aborted");
                }
                assert.equal(
                    (await lane.getResult("op-cancel", harnessContext))?.status,
                    "aborted",
                );
            } finally {
                await close();
            }
        });

        it("an aborted run is status=aborted with no partial marker: maxTurns partial must come from the runner", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([reply(long)] as never);
            const { lane, session, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-partial" },
                    harnessContext,
                );
                const driving = lane.drive({ operationId: "op-partial" }, harnessContext);
                await new Promise((r) => setTimeout(r, 120));
                await lane.abort(harnessContext);
                const driven = await driving;
                assert.ok(driven.ok && driven.value.kind === "settled");
                if (!driven.ok || driven.value.kind !== "settled") return;
                const outcome = driven.value.outcome;
                // Same status as a user cancel, so Work cannot tell "hit maxTurns" from
                // "user stopped it" by looking at pi's record.
                assert.equal(outcome.status, "aborted");
                assert.deepEqual(
                    Object.keys(outcome).sort(),
                    [
                        "endedAt",
                        "fromTipId",
                        "kind",
                        "operationId",
                        "startedAt",
                        "status",
                        "tipId",
                    ].sort(),
                    "the record carries no partial/reason field",
                );
                if (outcome.tipId !== null) {
                    const tip = await session.getEntry(outcome.tipId, harnessContext);
                    assert.equal(
                        tip?.type,
                        "message",
                        "the streamed prefix is kept as the branch tip",
                    );
                }
            } finally {
                await close();
            }
        });

        it("requestAbort with a stale operationId does not touch the live operation", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([reply("first"), reply(long)] as never);
            const { lane, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "one", operationId: "op-old" },
                    harnessContext,
                );
                await lane.drive({ operationId: "op-old" }, harnessContext);
                await lane.accept(
                    { kind: "prompt", prompt: "two", operationId: "op-new" },
                    harnessContext,
                );
                const driving = lane.drive({ operationId: "op-new" }, harnessContext);

                const stale = await lane.requestAbort("op-old", harnessContext);
                assert.equal(stale.ok, false, "stale id is rejected");
                assert.equal(
                    (stale as { error: { _tag: string } }).error._tag,
                    "OperationMismatch",
                );

                const driven = await driving;
                assert.ok(driven.ok && driven.value.kind === "settled");
                if (driven.ok && driven.value.kind === "settled") {
                    assert.equal(driven.value.outcome.status, "completed", "live run untouched");
                }
            } finally {
                await close();
            }
        });

        it("requestAbort twice reports newlyRequested=false the second time", async () => {
            const rig = makeRig({ tokensPerSecond: 40 });
            rig.faux.setResponses([reply(long)] as never);
            const { lane, close } = await rig.attach();
            try {
                await lane.accept(
                    { kind: "prompt", prompt: "go", operationId: "op-twice" },
                    harnessContext,
                );
                const driving = lane.drive({ operationId: "op-twice" }, harnessContext);
                await new Promise((r) => setTimeout(r, 60));
                const a = await lane.requestAbort("op-twice", harnessContext);
                const b = await lane.requestAbort("op-twice", harnessContext);
                await driving;
                assert.ok(a.ok);
                if (a.ok) assert.equal(a.value.newlyRequested, true);
                // b may be ok(newlyRequested:false) or a mismatch if the run already settled.
                if (b.ok) assert.equal(b.value.newlyRequested, false);
            } finally {
                await close();
            }
        });
    });
});
