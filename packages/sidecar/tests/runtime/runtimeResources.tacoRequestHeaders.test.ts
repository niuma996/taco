/**
 * `tacoRequestHeaders()` — single source of truth for taco-originated
 * outbound identification. Centralised so any future call site that
 * bypasses the harness streamOptions (memory extraction, fact
 * extraction, /v1/models probe) inherits the same tags.
 *
 * Regression coverage: shape, version source, mutation isolation.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { sidecarVersion, tacoRequestHeaders } from "../../src/runtime/runtimeResources.ts";

describe("tacoRequestHeaders", () => {
    it("returns user-agent and x-taco-sidecar-version keyed on the sidecar version", () => {
        const headers = tacoRequestHeaders();
        const version = sidecarVersion();
        assert.equal(headers["user-agent"], `taco/${version}`);
        assert.equal(headers["x-taco-sidecar-version"], version);
    });

    it("returns exactly the two identification headers and nothing else", () => {
        const headers = tacoRequestHeaders();
        assert.deepEqual(Object.keys(headers).sort(), ["user-agent", "x-taco-sidecar-version"]);
    });

    it("returns a fresh object on each call (callers may spread freely)", () => {
        const a = tacoRequestHeaders();
        const b = tacoRequestHeaders();
        assert.notEqual(a, b);
        assert.deepEqual(a, b);
    });

    it("yields header values that are plain strings (not arrays/nulls)", () => {
        // The OpenAI SDK headers and Node fetch HeadersInit both reject
        // arrays-of-strings or nulls in some shapes; pin the contract.
        const headers = tacoRequestHeaders();
        for (const value of Object.values(headers)) {
            assert.equal(typeof value, "string");
        }
    });
});