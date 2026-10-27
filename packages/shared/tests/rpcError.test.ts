/**
 * Client-side rendering of server errors — the sidecar reports schema failures
 * with an `issues` list, and every surface shows `error.message`, so the
 * details have to survive into the message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCodes, readValidationIssues } from "@taco-ai/protocol";
import { describeRpcError, formatValidationIssue, formatValidationIssues } from "../rpcError.js";

const issues = [
    {
        path: ["job", "id"],
        message: "Expected string",
        schema: "/properties/job/properties/id/type",
    },
    { path: [], message: "Expected object", schema: "/type" },
];

test("validation issues render as field paths with reasons", () => {
    assert.equal(formatValidationIssue(issues[0]), "/job/id: Expected string");
    assert.equal(formatValidationIssue(issues[1]), "(root): Expected object");
    assert.equal(
        formatValidationIssues(issues),
        "/job/id: Expected string; (root): Expected object",
    );
});

test("an invalid_params error keeps the server message and appends the issues", () => {
    const message = describeRpcError(ErrorCodes.InvalidParams, "parameter validation failed", {
        issues,
    });
    assert.equal(
        message,
        "parameter validation failed: /job/id: Expected string; (root): Expected object",
    );
});

test("other error codes keep the server wording", () => {
    assert.equal(
        describeRpcError(ErrorCodes.NotFound, "session not found", { issues }),
        "session not found",
    );
});

test("an invalid_params error without issues keeps the server wording", () => {
    assert.equal(
        describeRpcError(ErrorCodes.InvalidParams, "parameter validation failed", undefined),
        "parameter validation failed",
    );
    assert.equal(
        describeRpcError(ErrorCodes.InvalidParams, "parameter validation failed", { issues: [] }),
        "parameter validation failed",
    );
});

test("the reader rejects payloads it cannot trust", () => {
    assert.equal(readValidationIssues(undefined), undefined);
    assert.equal(readValidationIssues("nope"), undefined);
    assert.equal(readValidationIssues({ issues: "nope" }), undefined);
    assert.equal(readValidationIssues({ issues: [] }), undefined);
    assert.equal(readValidationIssues({ issues: [{ message: 42 }] }), undefined);
    assert.equal(readValidationIssues({ issues: [{ path: [1], message: "x" }] })?.length, 1);
});

test("a rejected call surfaces the issue details in the error message", async () => {
    const { FrameDispatcher, RpcRemoteError } = await import("../dispatcher.js");
    const dispatcher = new FrameDispatcher();
    const pending = dispatcher.registerPending("call-1");
    dispatcher.handleFrame({
        id: "call-1",
        ok: false,
        error: {
            code: ErrorCodes.InvalidParams,
            message: "parameter validation failed",
            data: { issues },
        },
    });
    await assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof RpcRemoteError);
        assert.equal(err.code, ErrorCodes.InvalidParams);
        assert.equal(
            err.message,
            "parameter validation failed: /job/id: Expected string; (root): Expected object",
        );
        return true;
    });
});
