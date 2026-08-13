/**
 * withTacoUserAgent — tags provider requests with the sidecar version, except
 * on OAuth providers where pi-ai's `claude-cli/<version>` identity must survive.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentHarnessStreamOptions } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { withTacoUserAgent } from "../../src/runtime/attachedSession.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";

/** Only `checkAuth` is exercised; the rest of Models is irrelevant here. */
const stubModels = (checkAuth: Models["checkAuth"]): Models => ({ checkAuth }) as unknown as Models;

const apiKeyModels = stubModels(async () => ({ source: "ANTHROPIC_API_KEY", type: "api_key" }));
const oauthModels = stubModels(async () => ({ source: "OAuth", type: "oauth" }));
const unknownModels = stubModels(async () => undefined);
const failingModels = stubModels(async () => {
    throw new Error("credential store read failed");
});

describe("withTacoUserAgent", () => {
    it("tags api-key providers with taco/<version>", async () => {
        const out = await withTacoUserAgent({}, apiKeyModels, "anthropic");
        const version = sidecarVersion();
        assert.equal(out.headers?.["user-agent"], `taco/${version}`);
        assert.equal(out.headers?.["x-taco-sidecar-version"], version);
    });

    it("leaves OAuth providers untagged so claude-cli identity survives", async () => {
        const out = await withTacoUserAgent({}, oauthModels, "anthropic");
        assert.equal(out.headers?.["user-agent"], undefined);
        assert.equal(out.headers?.["x-taco-sidecar-version"], undefined);
    });

    it("tags providers checkAuth cannot classify", async () => {
        const out = await withTacoUserAgent({}, unknownModels, "custom");
        assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
    });

    it("skips the tag instead of propagating a credential-store failure", async () => {
        const out = await withTacoUserAgent({}, failingModels, "anthropic");
        assert.equal(out.headers?.["user-agent"], undefined);
    });

    it("preserves caller headers and other stream options", async () => {
        const base: AgentHarnessStreamOptions = {
            headers: { "x-custom": "keep" },
            timeoutMs: 1234,
        };
        const out = await withTacoUserAgent(base, apiKeyModels, "anthropic");
        assert.equal(out.headers?.["x-custom"], "keep");
        assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
        assert.equal(out.timeoutMs, 1234);
        // MUST not mutate the caller's options
        assert.equal(base.headers?.["user-agent"], undefined);
    });

    it("lets a caller-supplied user-agent lose to the taco tag", async () => {
        const out = await withTacoUserAgent(
            { headers: { "user-agent": "caller/1.0" } },
            apiKeyModels,
            "anthropic",
        );
        assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
    });
});
