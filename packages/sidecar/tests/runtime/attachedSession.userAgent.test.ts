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
    it("tags api-key providers with taco/<version> + version header", async () => {
        const out = await withTacoUserAgent({}, apiKeyModels, "anthropic");
        const version = sidecarVersion();
        assert.equal(out.headers?.["user-agent"], `taco/${version}`);
        assert.equal(out.headers?.["x-taco-sidecar-version"], version);
    });

    it("leaves OAuth providers' user-agent alone but still tags the version", async () => {
        // `user-agent` must stay `claude-cli/<version>` for Anthropic OAuth
        // beta features. `x-taco-sidecar-version` is metadata only, so it
        // can ride alongside.
        const out = await withTacoUserAgent({}, oauthModels, "anthropic");
        const version = sidecarVersion();
        assert.equal(out.headers?.["user-agent"], undefined);
        assert.equal(out.headers?.["x-taco-sidecar-version"], version);
    });

    it("tags providers checkAuth cannot classify", async () => {
        const out = await withTacoUserAgent({}, unknownModels, "custom");
        assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
        assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
    });

    it("drops the user-agent override on credential-store failure but keeps the version header", async () => {
        // We can't know if the provider behind a failing credential store
        // is OAuth, so the UA override is unsafe. The version header is
        // safe metadata and stays.
        const out = await withTacoUserAgent({}, failingModels, "anthropic");
        const version = sidecarVersion();
        assert.equal(out.headers?.["user-agent"], undefined);
        assert.equal(out.headers?.["x-taco-sidecar-version"], version);
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

    it("drops a caller-supplied user-agent on OAuth paths so claude-cli survives", async () => {
        // Regression: the OAuth branch must not just OMIT its own UA tag
        // — it must actively strip a UA the caller placed in
        // streamOptions.headers, otherwise pi-ai's `claude-cli/<version>`
        // gets overridden and Claude Code's OAuth beta features break.
        const out = await withTacoUserAgent(
            { headers: { "user-agent": "caller/1.0", "x-custom": "keep" } },
            oauthModels,
            "anthropic",
        );
        assert.equal(out.headers?.["user-agent"], undefined);
        // The version header still rides; the caller's non-UA headers
        // (x-custom) are untouched.
        assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
        assert.equal(out.headers?.["x-custom"], "keep");
    });

    it("drops a caller-supplied user-agent on credential-store failure too", async () => {
        // Same reason as OAuth: we don't know if the failing provider is
        // OAuth, so any caller-supplied UA is unsafe to forward.
        const out = await withTacoUserAgent(
            { headers: { "user-agent": "caller/1.0" } },
            failingModels,
            "anthropic",
        );
        assert.equal(out.headers?.["user-agent"], undefined);
        assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
    });
});
