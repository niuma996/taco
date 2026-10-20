/**
 * AttachedSession — the lane's persisted model identity vs. the catalog.
 *
 * pi restores the lane configuration from the session file, and that
 * configuration carries the model identity. It therefore outranks the
 * attach-time seed: when the catalog moves on (an extra model renamed, a
 * static model hidden, a provider deleted), the lane keeps pointing at a
 * model that no longer exists. Every turn then fails with
 * `model_unavailable`, and the context panel reports an empty model name and
 * a zero context window.
 *
 * The attach path re-points a dead identity at a live model.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/attachedSession.modelIdentity.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";

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
        sessionCwd: tmp as never,
        getToolContext: () => ({ env, workspace: tmp as never }) as never,
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
});
