import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { readMemorySubmission } from "../../src/memory/submission.ts";
import type { AssistantMessage } from "../../src/runtime/pi/types.ts";

const tool = {
    name: "submit_test_plan",
    parameters: Type.Object(
        { actions: Type.Array(Type.String({ maxLength: 4 }), { maxItems: 2 }) },
        { additionalProperties: false },
    ),
};
const call = (overrides = {}) => ({
    type: "toolCall",
    id: "call-1",
    name: tool.name,
    arguments: { actions: ["keep"] },
    ...overrides,
});
const response = (content: unknown[], stopReason = "toolUse") =>
    ({ role: "assistant", content, stopReason }) as AssistantMessage;

describe("memory result submission", () => {
    it("accepts one complete call without text and an explicit empty result", () => {
        assert.deepEqual(readMemorySubmission(response([call()]), tool), { actions: ["keep"] });
        assert.deepEqual(
            readMemorySubmission(response([call({ arguments: { actions: [] } })]), tool),
            { actions: [] },
        );
    });

    it("ignores prose when the one result call is valid", () => {
        assert.deepEqual(
            readMemorySubmission(response([{ type: "text", text: "explanation" }, call()]), tool),
            { actions: ["keep"] },
        );
    });

    it("rejects text JSON, missing calls, wrong names and any additional call", () => {
        for (const content of [
            [{ type: "text", text: '{"actions":[]}' }],
            [],
            [call({ name: "another_tool" })],
            [call(), call()],
            [call(), call({ name: "another_tool" })],
        ]) {
            assert.throws(() => readMemorySubmission(response(content), tool));
        }
    });

    it("rejects invalid argument JSON, schema violations and oversized results", () => {
        for (const overrides of [
            { argumentsError: "incomplete JSON" },
            { arguments: {} },
            { arguments: { actions: [], injected: true } },
            { arguments: { actions: [42] } },
            { arguments: { actions: ["oversized"] } },
            { arguments: { actions: ["😀😀😀"] } },
            { arguments: { actions: ["a", "b", "c"] } },
        ]) {
            assert.throws(() => readMemorySubmission(response([call(overrides)]), tool));
        }
    });

    it("rejects partial calls even when arguments happen to pass the schema", () => {
        for (const stopReason of ["length", "error", "aborted", "pending", "deferred"]) {
            assert.throws(() => readMemorySubmission(response([call()], stopReason), tool));
        }
    });
});
