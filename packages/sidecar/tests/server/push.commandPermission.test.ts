import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { redactCommandPermissionRequest } from "../../src/server/push.ts";

describe("redactCommandPermissionRequest", () => {
    it("redacts API keys in the command string", () => {
        const request = {
            requestId: "req-1",
            sessionId: "session-1",
            toolCallId: "call-1",
            command:
                "curl -H 'Authorization: Bearer sk-ant-api03-abc123def456789012345xyz' https://api.example.com",
            evaluation: {
                behavior: "ask",
                risk: "externalSideEffect",
                reason: "network request",
            },
        };

        const [redacted, wasModified] = redactCommandPermissionRequest(request);
        assert.equal(wasModified, true);
        const redactedObj = redacted as typeof request;
        assert.ok(
            !redactedObj.command.includes("sk-ant-api03-abc123def456789012345xyz"),
            "API key must not appear in redacted command",
        );
        assert.match(redactedObj.command, /\[REDACTED:API_KEY\]/);
    });

    it("redacts bearer tokens outside headers", () => {
        const request = {
            requestId: "req-2",
            sessionId: "session-1",
            toolCallId: "call-2",
            command: "echo Bearer abc123def45678901234567890xyz",
            evaluation: {
                behavior: "ask",
                risk: "readOnly",
                reason: "echo",
            },
        };

        const [redacted, wasModified] = redactCommandPermissionRequest(request);
        assert.equal(wasModified, true);
        const redactedObj = redacted as typeof request;
        assert.ok(
            !redactedObj.command.includes("abc123def45678901234567890xyz"),
            "bearer token must not appear in redacted command",
        );
        assert.match(redactedObj.command, /\[REDACTED:BEARER_TOKEN\]/);
    });

    it("leaves safe commands untouched", () => {
        const request = {
            requestId: "req-3",
            sessionId: "session-1",
            toolCallId: "call-3",
            command: "git status",
            evaluation: {
                behavior: "ask",
                risk: "readOnly",
                reason: "git status",
            },
        };

        const [redacted, wasModified] = redactCommandPermissionRequest(request);
        assert.equal(wasModified, false);
        const redactedObj = redacted as typeof request;
        assert.equal(redactedObj.command, "git status");
    });
});
