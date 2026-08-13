/**
 * Regression: normalizeError does not propagate upstream error.message.
 * Fix: RpcHandlerError returned as-is; other throwable → code=internal, message
 * = "[upstream] " + redact long tokens/UUIDs + truncate to 200 chars.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { normalizeError, redactUpstreamMessage } from "../../src/server/server.ts";

describe("redactUpstreamMessage", () => {
    it("returns placeholder for empty input", () => {
        assert.equal(redactUpstreamMessage(""), "[upstream] error");
    });

    it("truncates messages longer than 200 chars", () => {
        const long = "x".repeat(500);
        const out = redactUpstreamMessage(long);
        assert.match(out, /^\[upstream\] /);
        assert.ok(out.length <= 220, `expected <= 220, got ${out.length}`);
    });

    it("redacts long alphanumeric tokens (key-shaped)", () => {
        // Simulates Anthropic-style 401: tail carries the key
        const in_ = "Your api key: sk-ant-api03-abc123def456789012345 is invalid";
        const out = redactUpstreamMessage(in_);
        assert.match(out, /^\[upstream\] /);
        assert.ok(!out.includes("abc123def456789012345"), "key tail must be redacted");
        assert.match(out, /…XXXX/);
    });

    it("redacts long hex runs that look like request ids (32 hex chars)", () => {
        // No hyphens — strictly not a uuid, but 32 hex looks just as suspicious.
        // The long-token regex should catch it.
        const in_ = "request id 06ba832bdaad11a605d5fe50525b0d65 failed";
        const out = redactUpstreamMessage(in_);
        assert.ok(!out.includes("06ba832bdaad11a605d5fe50525b0d65"), "hex run must be redacted");
        assert.match(out, /…XXXX/);
    });

    it("redacts dashed uuid-shaped strings", () => {
        const in_ = "request id 06ba832b-daad-11a6-05d5-fe50525b0d65 failed";
        const out = redactUpstreamMessage(in_);
        assert.ok(!out.includes("06ba832b-daad-11a6-05d5-fe50525b0d65"), "uuid must be redacted");
        assert.match(out, /…uuid/);
    });

    it("leaves short normal messages untouched (besides the prefix)", () => {
        const in_ = "provider returned no models";
        const out = redactUpstreamMessage(in_);
        assert.equal(out, "[upstream] provider returned no models");
    });
});

describe("normalizeError", () => {
    function callWith(thrown: unknown): { code: string; message: string } {
        const resp = normalizeError("req-1", thrown);
        assert.equal(resp.id, "req-1");
        assert.equal(resp.ok, false);
        // narrowed
        if (resp.ok) throw new Error("unreachable");
        return { code: resp.error.code, message: resp.error.message };
    }

    it("RpcHandlerError passes through untouched (our own errors)", async () => {
        const { RpcHandlerError } = await import("../../src/server/methodRegistry.ts");
        const e = new RpcHandlerError("invalid_params", "settings.write: baseUrl is required");
        const r = callWith(e);
        assert.equal(r.code, "invalid_params");
        assert.equal(r.message, "settings.write: baseUrl is required");
    });

    it("upstream Error.message gets a [upstream] prefix and internal code", () => {
        // A typical upstream 401 carries key fields as JSON / error codes.
        // Redaction targets key-shaped tokens, not arbitrary upstream text (all possible
        // internal field names cannot be enumerated). This test only covers the two
        // guarantees: unified prefix + no upstream code exposure.
        const upstreamMsg = "request id abc123def type=authentication_error";
        const e = new Error(upstreamMsg);
        const r = callWith(e);
        assert.equal(r.code, "internal", "upstream code must not leak");
        assert.match(r.message, /^\[upstream\] /);
        // Middle content is passed through (for user diagnostics); only the boundary prefix is added
        assert.ok(r.message.includes("request id"));
    });

    it("long key-shaped tokens inside the message ARE redacted", () => {
        const e = new Error("Your api key: sk-ant-api03-abc123def456789012345xyz is invalid");
        const r = callWith(e);
        assert.ok(!r.message.includes("abc123def456789012345xyz"), "key tail must be redacted");
        assert.match(r.message, /…XXXX/);
    });

    it("non-Error throwables (string, number) are also redacted", () => {
        const r = callWith("just a string error");
        assert.equal(r.code, "internal");
        assert.equal(r.message, "[upstream] just a string error");

        const r2 = callWith(42);
        assert.equal(r2.code, "internal");
        assert.equal(r2.message, "[upstream] 42");
    });
});
