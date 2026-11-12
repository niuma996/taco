import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import * as protocol from "../src/index.ts";

test("started is a distinct push with a required run identity", () => {
    assert.equal(protocol.PushMethods.SubagentStarted, "subagent.started");
    const schema = protocol.pushSchemas[protocol.PushMethods.SubagentStarted];
    const params = {
        parentSessionId: "parent",
        parentToolCallId: "original-spawn",
        subSessionId: "child",
        agentType: "reviewer",
        runId: "run-new",
    };
    assert.equal(Check(schema, params), true);
    for (const key of Object.keys(params)) {
        const missing: Record<string, unknown> = { ...params };
        delete missing[key];
        assert.equal(Check(schema, missing), false, key);
        assert.equal(Check(schema, { ...params, [key]: "" }), false, key);
    }
});

test("spawned and settled schemas remain compatible with events without runId", () => {
    assert.ok(protocol.pushSchemas, "subagent push schemas must be exported");
    const params = {
        parentSessionId: "parent",
        parentToolCallId: "original-spawn",
        subSessionId: "child",
        agentType: "reviewer",
    };
    for (const runId of [undefined, "run-1"]) {
        assert.equal(
            Check(protocol.pushSchemas[protocol.PushMethods.SubagentSpawned], { ...params, runId }),
            true,
        );
        for (const outcome of ["completed", "error", "aborted"])
            assert.equal(
                Check(protocol.pushSchemas[protocol.PushMethods.SubagentSettled], {
                    ...params,
                    outcome,
                    runId,
                }),
                true,
            );
    }
});
