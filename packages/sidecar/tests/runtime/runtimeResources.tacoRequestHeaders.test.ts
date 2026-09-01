/**
 * `tacoRequestHeaders()` — single source of truth for taco-originated
 * outbound identification. Centralised so any future call site that
 * bypasses the harness streamOptions (memory extraction, fact
 * extraction, /v1/models probe) inherits the same tags.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { sidecarVersion, tacoRequestHeaders } from "../../src/runtime/runtimeResources.ts";

describe("tacoRequestHeaders", () => {
    it("returns { user-agent, x-taco-sidecar-version } keyed on the sidecar version with plain string values", () => {
        const headers = tacoRequestHeaders();
        const version = sidecarVersion();
        // The OpenAI SDK and Node fetch HeadersInit both reject array/null
        // values; pin shape and value types in one shot.
        assert.deepEqual(Object.keys(headers).sort(), ["user-agent", "x-taco-sidecar-version"]);
        assert.equal(headers["user-agent"], `taco/${version}`);
        assert.equal(headers["x-taco-sidecar-version"], version);
        for (const value of Object.values(headers)) {
            assert.equal(typeof value, "string");
        }
    });
});
