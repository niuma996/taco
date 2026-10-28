/**
 * AttachedSession — the persisted model identity versus the catalog, and the
 * memory-extraction run coordinator.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import {
    type MemoryExtractor,
    type MemoryStore,
    sliceForExtraction,
} from "../../src/memory/index.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { createMemoryExtractionHandlers } from "../../src/runtime/harness/turnBookkeeping.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";

describe("attachedSession.modelIdentity", () => {
    let tmp: string;

    before(() => {
        tmp = mkdtempSync(join(tmpdir(), "taco-model-identity-"));
    });

    after(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    function taskStoreStub(): TaskStore {
        return {
            lists: new Map(),
            getTaskState: () => ({ planMode: false, currentTask: undefined }),
            setTaskState: () => {},
        } as unknown as TaskStore;
    }

    async function attach(
        models: ReturnType<typeof createModels>,
        model: unknown,
        session: unknown,
        options: { memoryStore?: MemoryStore; sessionKind?: "main" | "subagent" } = {},
    ): Promise<AttachedSession> {
        const env = new NodeExecutionEnv({ cwd: tmp });
        return await AttachedSession.create({
            session,
            models,
            model: model as never,
            env,
            systemPrompt: "test",
            tools: [],
            resources: {},
            streamOptions: {},
            taskStore: taskStoreStub(),
            planState: createPlanModeState(),
            tasksDir: tmp,
            attachmentsDir: tmp,
            sessionCwd: tmp as never,
            getToolContext: () => ({ env, workspace: tmp as never }) as never,
            memoryStore: options.memoryStore,
            sessionKind: options.sessionKind ?? "main",
        } as never);
    }

    /**
     * Create a session, attach it under `provider`, and hand back everything
     * needed to re-attach the same session file later.
     */
    async function seedSession(provider: string, modelIds?: string[]) {
        const env = new NodeExecutionEnv({ cwd: tmp });
        const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(tmp, "sessions") });
        const faux = fauxProvider({
            provider,
            ...(modelIds ? { models: modelIds.map((id) => ({ id })) } : {}),
            tokensPerSecond: 0,
        } as never);
        faux.setResponses([fauxAssistantMessage([fauxText("hi")])] as never);
        const models = createModels();
        models.setProvider(faux.provider);
        const session = await repo.create({ cwd: tmp }, harnessContext);
        const attached = await attach(models, faux.getModel(), session);
        await attached.dispose();
        await session.close(harnessContext);
        return { repo, models };
    }

    /** A faux provider that answers one "hi" — used to fill the catalog. */
    function liveProvider(provider: string, modelIds: string[]) {
        const faux = fauxProvider({
            provider,
            models: modelIds.map((id) => ({ id })),
            tokensPerSecond: 0,
        } as never);
        faux.setResponses([fauxAssistantMessage([fauxText("hi")])] as never);
        return faux;
    }

    describe("AttachedSession — model identity vs. the catalog", () => {
        it("re-points a persisted model id that is no longer in the catalog", async () => {
            const { repo, models } = await seedSession("faux");

            // The catalog moved on: the old provider is gone, a new one exists.
            models.deleteProvider("faux");
            const replacement = fauxProvider({ provider: "faux2", tokensPerSecond: 0 } as never);
            replacement.setResponses([fauxAssistantMessage([fauxText("hi")])] as never);
            models.setProvider(replacement.provider);

            const metas = await repo.list({}, harnessContext);
            const reopened = await repo.open(metas[0], harnessContext);
            const attached = await attach(models, replacement.getModel(), reopened);
            try {
                const info = await attached.getContextInfo();
                assert.equal(info.provider, "faux2", "the lane must follow the live model");
                assert.notEqual(info.modelId, "");
                assert.ok(info.contextWindow > 0, "a dead model reports a zero window");
                // The turn must run — a dead identity fails with model_unavailable.
                await attached.prompt("hi", undefined, undefined);
            } finally {
                await attached.dispose();
            }
        });

        it("re-points at a sibling of the same provider, not at another provider", async () => {
            const { repo, models } = await seedSession("faux", ["m1"]);

            // The catalog moved on: "m1" is gone and "m2" took its place in the
            // same provider, while an unrelated provider was registered first —
            // so the catalog's *first* model belongs to a provider this session
            // never talked to.
            models.deleteProvider("faux");
            models.setProvider(liveProvider("other", ["z"]).provider);
            models.setProvider(liveProvider("faux", ["m2"]).provider);

            // The attach-time seed is dead too (the default model was renamed
            // along with the extra), so the re-point has to choose on its own.
            const deadSeed = liveProvider("faux", ["gone"]);

            const metas = await repo.list({}, harnessContext);
            const reopened = await repo.open(metas[0], harnessContext);
            const attached = await attach(models, deadSeed.getModel(), reopened);
            try {
                const info = await attached.getContextInfo();
                assert.equal(info.provider, "faux", "the session stays on its own provider");
                assert.equal(info.modelId, "m2", "and lands on the provider's live model");
            } finally {
                await attached.dispose();
            }
        });

        it("leaves a live model identity alone", async () => {
            const { repo, models } = await seedSession("faux");
            const metas = await repo.list({}, harnessContext);
            const reopened = await repo.open(metas[0], harnessContext);
            const faux = fauxProvider({ provider: "faux", tokensPerSecond: 0 } as never);
            faux.setResponses([fauxAssistantMessage([fauxText("hi")])] as never);
            models.setProvider(faux.provider);
            const attached = await attach(models, faux.getModel(), reopened);
            try {
                const info = await attached.getContextInfo();
                assert.equal(info.provider, "faux");
                assert.notEqual(info.modelId, "");
                assert.ok(info.contextWindow > 0);
            } finally {
                await attached.dispose();
            }
        });

        it("enables memory extraction for main sessions but not subagents", async () => {
            const env = new NodeExecutionEnv({ cwd: tmp });
            const repo = new JsonlSessionRepo({
                fileSystem: env,
                sessionsRoot: join(tmp, "sessions"),
            });
            const faux = fauxProvider({ provider: "faux", tokensPerSecond: 0 } as never);
            faux.setResponses([fauxAssistantMessage([fauxText("hi")])] as never);
            const models = createModels();
            models.setProvider(faux.provider);
            const memoryStore = { enabled: true } as MemoryStore;
            const extractorOf = (attached: AttachedSession): unknown =>
                (attached as unknown as { memoryExtractor?: unknown }).memoryExtractor;

            const mainSession = await repo.create({ cwd: tmp }, harnessContext);
            const main = await attach(models, faux.getModel(), mainSession, {
                memoryStore,
                sessionKind: "main",
            });
            assert.ok(extractorOf(main));

            const childSession = await repo.create({ cwd: tmp }, harnessContext);
            const child = await attach(models, faux.getModel(), childSession, {
                memoryStore,
                sessionKind: "subagent",
            });
            assert.equal(extractorOf(child), undefined);

            await main.dispose();
            await child.dispose();
            await mainSession.close(harnessContext);
            await childSession.close(harnessContext);
        });
    });
});

describe("attachedSession.rememberCoord", () => {
    // ─── helpers ──────────────────────────────────────────────────────────────────

    // AgentMessage is a discriminated union; the test only cares about identity
    // for slicing, so we cast through `unknown` and probe fields via `role` /
    // stringified payload.
    const msg = (role: AgentMessage["role"], content: string): AgentMessage =>
        ({ role, content }) as unknown as AgentMessage;

    const messages = (n: number): AgentMessage[] =>
        Array.from({ length: n }, (_, i) => msg("user", `m${i}`));

    /** Identity probe: every fixture has role=+content; stringify both for a
     *  cheap equality check that survives the discriminated-union cast. */
    const identify = (m: AgentMessage): string =>
        `${m.role}:${(m as unknown as { content: string }).content}`;

    // ─── sliceForExtraction ───────────────────────────────────────────────────────

    describe("sliceForExtraction", () => {
        const all = messages(5);

        it("returns full messages when sinceCount is undefined", () => {
            const out = sliceForExtraction(all, undefined);
            assert.equal(out.length, 5);
            assert.ok(out[0]);
            assert.ok(out[4]);
            assert.equal(identify(out[0]), "user:m0");
            assert.equal(identify(out[4]), "user:m4");
            // MUST be a copy — caller may mutate
            assert.notEqual(out, all);
        });

        it("returns messages from offset when sinceCount is in range", () => {
            const out = sliceForExtraction(all, 3);
            assert.equal(out.length, 2);
            assert.ok(out[0]);
            assert.ok(out[1]);
            assert.equal(identify(out[0]), "user:m3");
            assert.equal(identify(out[1]), "user:m4");
        });

        it("returns full messages when sinceCount is 0", () => {
            const out = sliceForExtraction(all, 0);
            assert.equal(out.length, 5);
            assert.ok(out[0]);
            assert.equal(identify(out[0]), "user:m0");
        });

        it("returns empty array when sinceCount equals length (no new messages)", () => {
            const out = sliceForExtraction(all, all.length);
            assert.equal(out.length, 0);
        });

        it("returns empty array when sinceCount exceeds length (defensive)", () => {
            const out = sliceForExtraction(all, all.length + 10);
            assert.equal(out.length, 0);
        });

        it("clamps negative sinceCount to 0 (defensive)", () => {
            const out = sliceForExtraction(all, -5);
            assert.equal(out.length, 5);
            assert.ok(out[0]);
            assert.equal(identify(out[0]), "user:m0");
        });

        it("returns [] when input is [] regardless of sinceCount", () => {
            assert.equal(sliceForExtraction([], undefined).length, 0);
            assert.equal(sliceForExtraction([], 0).length, 0);
            assert.equal(sliceForExtraction([], 3).length, 0);
        });
    });

    // ─── run coordinator ──────────────────────────────────────────────────────────

    class MiniExtractor implements MemoryExtractor {
        readonly calls: AgentMessage[][] = [];

        async onRunEnd(messages: readonly AgentMessage[]): Promise<void> {
            this.calls.push(messages.slice());
        }
    }

    function makeCoordinator(
        buildContext: () => Promise<AgentMessage[]>,
        extractor: MemoryExtractor | undefined,
    ) {
        return createMemoryExtractionHandlers({ buildContext, getExtractor: () => extractor });
    }

    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    describe("memory extraction coordinator — one extraction per completed run", () => {
        it("run_end with no prior memory call gets the full conversation", async () => {
            const extractor = new MiniExtractor();
            const handlers = makeCoordinator(async () => messages(4), extractor);

            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls.length, 1);
            assert.equal(extractor.calls[0]?.length, 4);
            assert.equal(identify(extractor.calls[0][0]), "user:m0");
        });

        it("memory tool then run_end slices to messages after the offset", async () => {
            const extractor = new MiniExtractor();
            let buildIndex = 0;
            const handlers = makeCoordinator(async () => {
                buildIndex++;
                return messages(buildIndex === 1 ? 3 : 5);
            }, extractor);

            handlers.onToolEnd("memory", false);
            await flush();
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls.length, 1);
            assert.deepEqual(extractor.calls[0].map(identify), ["user:m3", "user:m4"]);
        });

        it("a compaction mid-run drops the offsets, so the run is not skipped", async () => {
            const extractor = new MiniExtractor();
            let buildIndex = 0;
            const handlers = makeCoordinator(async () => {
                buildIndex++;
                // 8 messages at the memory call, then compaction shrinks it to 3.
                return messages(buildIndex === 1 ? 8 : 3);
            }, extractor);

            handlers.onToolEnd("memory", false);
            await flush();
            handlers.onCompaction();
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls.length, 1, "the run still extracts");
            assert.equal(extractor.calls[0]?.length, 3);
        });

        it("offsets reset at run_end even while their snapshots are pending", async () => {
            const extractor = new MiniExtractor();
            let buildIndex = 0;
            const handlers = makeCoordinator(async () => {
                buildIndex++;
                return messages(buildIndex <= 2 ? 2 : 4);
            }, extractor);

            handlers.onToolEnd("memory", false);
            handlers.onRunEnd("completed");
            await flush();
            assert.equal(extractor.calls.length, 0);

            handlers.onRunEnd("completed");
            await flush();
            assert.deepEqual(extractor.calls[0].map(identify), [
                "user:m0",
                "user:m1",
                "user:m2",
                "user:m3",
            ]);
        });

        it("run_end skips extraction when the sliced range is empty", async () => {
            const extractor = new MiniExtractor();
            const handlers = makeCoordinator(async () => messages(5), extractor);

            handlers.onToolEnd("memory", false);
            await flush();
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls.length, 0);
        });

        it("a failed memory tool does not capture an offset", async () => {
            const extractor = new MiniExtractor();
            const handlers = makeCoordinator(async () => messages(3), extractor);

            handlers.onToolEnd("memory", true);
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls[0]?.length, 3);
        });

        it("non-memory tools do not capture an offset", async () => {
            const extractor = new MiniExtractor();
            const handlers = makeCoordinator(async () => messages(3), extractor);

            handlers.onToolEnd("read", false);
            handlers.onToolEnd("write", false);
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls[0]?.length, 3);
        });

        it("two memory calls in one run use the earliest offset", async () => {
            const extractor = new MiniExtractor();
            let resolveFirst: ((messages: AgentMessage[]) => void) | undefined;
            let resolveSecond: ((messages: AgentMessage[]) => void) | undefined;
            const first = new Promise<AgentMessage[]>((resolve) => {
                resolveFirst = resolve;
            });
            const second = new Promise<AgentMessage[]>((resolve) => {
                resolveSecond = resolve;
            });
            let buildIndex = 0;
            const handlers = makeCoordinator(() => {
                buildIndex++;
                if (buildIndex === 1) return first;
                if (buildIndex === 2) return second;
                return Promise.resolve(messages(10));
            }, extractor);

            handlers.onToolEnd("memory", false);
            handlers.onToolEnd("memory", false);
            handlers.onRunEnd("completed");
            resolveSecond?.(messages(3));
            resolveFirst?.(messages(5));
            await flush();

            assert.equal(extractor.calls.length, 1);
            assert.equal(extractor.calls[0].length, 7);
            assert.equal(identify(extractor.calls[0][0]), "user:m3");
        });

        it("a rejected offset snapshot skips extraction without rejecting the run", async () => {
            const extractor = new MiniExtractor();
            let buildIndex = 0;
            const handlers = makeCoordinator(async () => {
                buildIndex++;
                if (buildIndex === 1) throw new Error("session boom");
                return messages(4);
            }, extractor);

            handlers.onToolEnd("memory", false);
            handlers.onRunEnd("completed");
            await flush();

            assert.equal(extractor.calls.length, 0);
        });

        it("aborted and failed runs do not extract or leak offsets", async () => {
            const extractor = new MiniExtractor();
            const handlers = makeCoordinator(async () => messages(3), extractor);

            handlers.onToolEnd("memory", false);
            handlers.onRunEnd("aborted");
            handlers.onRunEnd("failed");
            await flush();
            assert.equal(extractor.calls.length, 0);

            handlers.onRunEnd("completed");
            await flush();
            assert.equal(extractor.calls.length, 1);
            assert.equal(extractor.calls[0].length, 3);
        });

        it("a disabled extractor does not build the run context", async () => {
            let builds = 0;
            const handlers = makeCoordinator(async () => {
                builds++;
                return messages(3);
            }, undefined);

            handlers.onRunEnd("completed");
            await flush();
            assert.equal(builds, 0);
        });
    });
});
