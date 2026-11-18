/**
 * Outbound request identity: the User-Agent the sidecar presents to model
 * providers, and how a user-configured value replaces the default one.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { withTacoUserAgent } from "../../src/runtime/models/requestHeaders.ts";
import type { Models } from "../../src/runtime/pi/types.ts";
import { buildRequestHeaders, setRequestIdentity } from "../../src/runtime/requestIdentity.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";

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
        /** Only `checkAuth` is exercised; the rest of Models is irrelevant here. */
        const stubModels = (checkAuth: Models["checkAuth"]): Models =>
            ({ checkAuth }) as unknown as Models;

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
