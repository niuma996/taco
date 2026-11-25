/**
 * Outbound request identity: the User-Agent the sidecar presents to model
 * providers, and how a user-configured value replaces the default one.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { withTacoUserAgent } from "../../src/runtime/models/requestHeaders.ts";
import type { AgentHarnessStreamOptions, Models } from "../../src/runtime/pi/types.ts";
import { buildRequestHeaders, setRequestIdentity } from "../../src/runtime/requestIdentity.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";

/** Only `checkAuth` is exercised; the rest of Models is irrelevant here. */
const stubModels = (checkAuth: Models["checkAuth"]): Models => ({ checkAuth }) as unknown as Models;

describe("requestIdentity", () => {
    afterEach(() => {
        // The identity is process-wide — every test starts from the default.
        setRequestIdentity({});
    });

    it("sends the default taco identity when nothing is configured", () => {
        const headers = buildRequestHeaders();
        assert.equal(headers["user-agent"], `taco/${sidecarVersion()}`);
        assert.equal(headers["x-taco-sidecar-version"], sidecarVersion());
    });

    it("replaces the UA and drops the version header for a custom identity", () => {
        setRequestIdentity({ userAgent: "my-gateway/1.0" });
        const headers = buildRequestHeaders();
        assert.equal(headers["user-agent"], "my-gateway/1.0");
        // The version header names taco outright — keeping it would defeat
        // the point of a custom identity.
        assert.equal(headers["x-taco-sidecar-version"], undefined);
    });

    it("keeps the version header on OAuth paths when no identity is configured", () => {
        const headers = buildRequestHeaders({ oauth: true });
        // `user-agent` stays out of the way: pi-ai sends its own
        // `claude-cli/<version>` for Anthropic OAuth.
        assert.equal(headers["user-agent"], undefined);
        assert.equal(headers["x-taco-sidecar-version"], sidecarVersion());
    });

    it("sends nothing on OAuth paths with a custom identity", () => {
        // A custom UA must not override pi-ai's `claude-cli/<version>` — that
        // would cost the Claude Code OAuth beta features.
        setRequestIdentity({ userAgent: "my-gateway/1.0" });
        assert.deepEqual(buildRequestHeaders({ oauth: true }), {});
    });

    it("trims the configured value and treats an empty one as unset", () => {
        setRequestIdentity({ userAgent: "  my-gateway/1.0  " });
        assert.equal(buildRequestHeaders()["user-agent"], "my-gateway/1.0");
        setRequestIdentity({ userAgent: "   " });
        assert.equal(buildRequestHeaders()["user-agent"], `taco/${sidecarVersion()}`);
    });

    describe("withTacoUserAgent", () => {
        const apiKeyModels = stubModels(async () => ({
            source: "ANTHROPIC_API_KEY",
            type: "api_key",
        }));
        const oauthModels = stubModels(async () => ({ source: "OAuth", type: "oauth" }));

        it("applies the custom identity on api-key providers", async () => {
            setRequestIdentity({ userAgent: "my-gateway/1.0" });
            const out = await withTacoUserAgent({}, apiKeyModels, "anthropic");
            assert.equal(out.headers?.["user-agent"], "my-gateway/1.0");
            assert.equal(out.headers?.["x-taco-sidecar-version"], undefined);
        });

        it("keeps the OAuth identity intact while dropping the version header", async () => {
            setRequestIdentity({ userAgent: "my-gateway/1.0" });
            const out = await withTacoUserAgent({}, oauthModels, "anthropic");
            // No UA of our own — pi-ai's `claude-cli/<version>` must survive.
            assert.equal(out.headers?.["user-agent"], undefined);
            assert.equal(out.headers?.["x-taco-sidecar-version"], undefined);
        });

        it("still lets the custom identity win over a caller-supplied UA", async () => {
            setRequestIdentity({ userAgent: "my-gateway/1.0" });
            const out = await withTacoUserAgent(
                { headers: { "user-agent": "caller/1.0" } },
                apiKeyModels,
                "anthropic",
            );
            assert.equal(out.headers?.["user-agent"], "my-gateway/1.0");
        });
    });
});

describe("requestHeaders.userAgent", () => {
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
});
