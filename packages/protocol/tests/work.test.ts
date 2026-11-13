import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
    RPC,
    rpcContract,
    rpcSchemas,
    SIDECAR_PROTOCOL_VERSION,
    WORK_KINDS,
} from "../src/index.ts";

test("work controls are process-scoped methods in protocol 2.18", () => {
    assert.deepEqual(SIDECAR_PROTOCOL_VERSION, { major: 2, minor: 18 });
    assert.equal(RPC.workCancel, "work.cancel");
    assert.equal(RPC.workDelete, "work.delete");
    assert.equal(rpcContract.workCancel.scope, "process");
    assert.equal(rpcContract.workDelete.scope, "process");
});

test("cancellation requires an attempt identity and both controls reject path-like Work ids", () => {
    assert.ok(rpcSchemas.workCancel, "cancellation must declare its schema");
    assert.ok(rpcSchemas.workDelete, "deletion must declare its schema");
    assert.equal(Check(rpcSchemas.workCancel, { workId: "w-1", attemptId: "attempt-1" }), true);
    for (const attemptId of [undefined, "", 12]) {
        assert.equal(Check(rpcSchemas.workCancel, { workId: "w-1", attemptId }), false);
    }
    assert.equal(Check(rpcSchemas.workDelete, { workId: "w-1" }), true);
    for (const workId of ["", "../escape", "a/b", 12]) {
        assert.equal(Check(rpcSchemas.workCancel, { workId, attemptId: "a" }), false);
        assert.equal(Check(rpcSchemas.workDelete, { workId }), false);
    }
});

test("queued intents cancel by queue revision without a fabricated attempt id", () => {
    const queueId = `q-${"a".repeat(32)}`;
    assert.equal(RPC.workQueueCancel, "work.queueCancel");
    assert.equal(rpcContract.workQueueCancel.scope, "process");
    assert.equal(Check(rpcSchemas.workQueueCancel, { queueId, revision: 0 }), true);
    for (const params of [
        { queueId },
        { queueId, revision: -1 },
        { queueId: "../escape", revision: 0 },
    ]) {
        assert.equal(Check(rpcSchemas.workQueueCancel, params), false);
    }
    assert.ok(WORK_KINDS.includes("inbound"));
});
