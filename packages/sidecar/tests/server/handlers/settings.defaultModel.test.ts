/**
 * settings.write handler — defaultModel push path:
 *   when patch includes defaultModel and/or defaultProvider, the handler calls
 *   server.setDefaultModel so existing workspaces re-resolve their default
 *   model in real time. Without this, a workspace built before the user picked
 *   a provider keeps its construction-time fallback (first catalog model) and
 *   the next session.create fails with "Provider is not configured".
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.defaultModel.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("settings-defaultmodel");

before(() => {
    registerBuiltinMethods();
});

interface DefaultModelCall {
    defaultModel?: string;
    defaultProvider?: string;
}

function makeServer(calls: DefaultModelCall[]) {
    return {
        providerKeyStore: undefined,
        setCustomProviders(): void {},
        broadcastModelsChanged(): void {},
        setDefaultModel(defaultModel?: string, defaultProvider?: string): void {
            calls.push({ defaultModel, defaultProvider });
        },
    };
}

describe("settings.write — defaultModel push", () => {
    it("fires when only defaultProvider changes (it scopes the model lookup)", async () => {
        const calls: DefaultModelCall[] = [];
        const server = makeServer(calls);
        // defaultModel already on disk from the previous test; change provider only.
        await callMethod("settings.write", {
            server,
            params: { global: { defaultProvider: "minimax" } },
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].defaultProvider, "minimax");
    });

    it("does NOT push when the patch touches neither field", async () => {
        const calls: DefaultModelCall[] = [];
        const server = makeServer(calls);
        await callMethod("settings.write", {
            server,
            params: { global: { thinkingLevel: "low" } },
        });

        assert.equal(calls.length, 0);
    });
});
