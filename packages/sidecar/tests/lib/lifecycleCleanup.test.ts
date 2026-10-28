import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeInOrder } from "../../src/lib/async.ts";

test("cleanup attempts every resource in order and reports all failures", async () => {
    const calls: number[] = [];
    const first = new Error("first failed");
    const last = new Error("last failed");
    const closing = disposeInOrder([
        () => {
            calls.push(1);
            throw first;
        },
        async () => {
            calls.push(2);
        },
        async () => {
            calls.push(3);
            throw last;
        },
    ]);
    await assert.rejects(closing, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, last]);
        return true;
    });
    assert.deepEqual(calls, [1, 2, 3]);
});
