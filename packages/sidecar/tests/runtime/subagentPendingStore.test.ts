import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { SubagentPendingStore } from "../../src/runtime/subagent/subagentPendingStore.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

async function fixture(t: TestContext) {
    const { ws, cwd, cleanup } = createTestWorkspace();
    t.after(cleanup);
    const parent = asSessionId("pending-parent");
    const session = await ws.repo.create({ id: parent, cwd }, harnessContext);
    await session.close(harnessContext);
    const store = new SubagentPendingStore(ws.sessionRegistry);
    const entry = {
        parentToolCallId: "call",
        subSessionId: asSessionId("child"),
        runId: "run-1",
        agentType: "explorer",
        outcome: "completed" as const,
        settledAt: 1,
    };
    return { store, parent, entry };
}

test("a stale delivery cannot delete a replacement run's pending result", async (t) => {
    const { store, parent, entry } = await fixture(t);
    await store.record(parent, entry);
    const replacement = { ...entry, runId: "run-2", settledAt: 2 };
    await store.record(parent, replacement);
    await store.remove(parent, entry);
    assert.deepEqual(await store.read(parent), [replacement]);
    await store.remove(parent, replacement);
    assert.deepEqual(await store.read(parent), []);
});

test("concurrent records retain both results and fallback cannot replace the real result", async (t) => {
    const { store, parent, entry } = await fixture(t);
    const second = { ...entry, parentToolCallId: "second" };
    await Promise.all([store.record(parent, entry), store.record(parent, second)]);
    await store.record(parent, { ...entry, outcome: "error" }, true);
    assert.deepEqual(await store.read(parent), [entry, second]);
});
