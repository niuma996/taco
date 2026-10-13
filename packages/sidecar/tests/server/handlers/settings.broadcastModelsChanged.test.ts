/**
 * settings.write handler — broadcastModelsChanged trigger conditions:
 *  broadcasts only when the patch contains apiKeys or customProviders;
 *  unrelated fields (defaultModel, compaction, etc.) do not trigger it.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.broadcastModelsChanged.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("settings-broadcast");

before(() => {
    registerBuiltinMethods();
});

function makeServer(): { server: unknown; getCalls: () => number } {
    let calls = 0;
    return {
        server: {
            providerKeyStore: new ProviderKeyStore({}),
            setCustomProviders(): void {},
            broadcastModelsChanged(): void {
                calls++;
            },
        },
        getCalls: () => calls,
    };
}

describe("settings.write — broadcastModelsChanged trigger", () => {
    it("broadcasts once when customProviders changes", async () => {
        const { server, getCalls } = makeServer();
        await callMethod("settings.write", { server, params: { global: { customProviders: [] } } });
        assert.equal(getCalls(), 1);
    });

    it("does NOT broadcast when patch touches only unrelated fields", async () => {
        const { server, getCalls } = makeServer();
        await callMethod("settings.write", {
            server,
            params: { global: { defaultModel: "anthropic/claude-x" } },
        });
        assert.equal(getCalls(), 0, "defaultModel-only patch must not broadcast");
    });
});
