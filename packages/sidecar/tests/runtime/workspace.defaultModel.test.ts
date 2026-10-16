/**
 * WorkspaceRuntime — default model resolution policy.
 *
 * A configured default can stop resolving whenever the catalog moves under it:
 * the provider is deleted, or the model is removed from a provider's list (an
 * extra dropped, a static hidden, a custom provider's list edited). The
 * constructor and the hot-reload path used to disagree on what to do about that
 * — construction returned undefined (every session.create then failed with
 * "no model configured", a message that points at the wrong thing) while
 * hot-reload silently kept the previous value (looked fine, broke on the next
 * restart). Both now fall back to the first catalog model.
 *
 * A cleared API key is NOT one of these: the model still resolves and the
 * failure surfaces per-request as "Provider is not configured", so the test
 * file deliberately excludes that case.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/workspace.defaultModel.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { asWorkspaceId, type CustomProviderConfig } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const tmpDir = useTempTacoHome("defaultmodel");

function makeWorkspace(
    defaultModel?: string,
    defaultProvider?: string,
    customProviders?: readonly CustomProviderConfig[],
): WorkspaceRuntime {
    return new WorkspaceRuntime({
        providerKeyStore: new ProviderKeyStore({}),
        cwd: asWorkspaceId(tmpDir),
        defaultModel,
        defaultProvider,
        customProviders,
    });
}

const RELAY: CustomProviderConfig = {
    id: "custom:relay",
    name: "Relay",
    api: "chatcomplete",
    baseUrl: "https://relay.example/v1",
    models: [{ id: "relay-fast" }],
};

describe("WorkspaceRuntime — default model resolution", () => {
    it("uses the configured default when it resolves", () => {
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        assert.equal(ws.defaultModel?.id, "relay-fast");
        assert.equal(ws.defaultModel?.provider, RELAY.id);
    });

    it("falls back to the first catalog model when the provider is gone", () => {
        // The exact regression: defaultProvider named a deleted custom provider.
        const ws = makeWorkspace("relay-fast", "custom:deleted", []);
        assert.ok(ws.defaultModel, "a stale default must not leave the workspace without a model");
        assert.notEqual(ws.defaultModel?.provider, "custom:deleted");
    });

    it("falls back when the model was removed from a live provider's list", () => {
        const ws = makeWorkspace("relay-gone", RELAY.id, [RELAY]);
        assert.ok(ws.defaultModel);
        assert.notEqual(ws.defaultModel?.id, "relay-gone");
    });

    it("still falls back to the first catalog model when no default is configured", () => {
        const ws = makeWorkspace(undefined, undefined, [RELAY]);
        assert.ok(ws.defaultModel);
    });

    it("setDefaultModel applies the same fallback instead of keeping a stale value", () => {
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        const before = ws.defaultModel?.id;
        assert.equal(before, "relay-fast");

        // Hot-reload pointing at a provider that no longer exists.
        ws.setDefaultModel("relay-fast", "custom:deleted");
        assert.ok(ws.defaultModel, "must not fall through to undefined");
        assert.notEqual(ws.defaultModel?.provider, "custom:deleted");
    });

    it("setDefaultModel re-resolves the same id after the provider qualifier is dropped", () => {
        // What the desktop's delete path now writes: defaultProvider cleared,
        // defaultModel kept — the cross-provider search finds it again.
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        ws.setDefaultModel("relay-fast", undefined);
        assert.equal(ws.defaultModel?.id, "relay-fast");
        assert.equal(ws.defaultModel?.provider, RELAY.id);
    });
});
