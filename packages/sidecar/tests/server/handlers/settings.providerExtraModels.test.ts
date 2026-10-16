/**
 * settings.write handler — providerExtraModels push path:
 * when patch includes providerExtraModels, the handler persists it, calls
 * server.setProviderExtraModels so existing workspace catalogs re-register
 * wrapped built-ins, and broadcasts models.changed.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.providerExtraModels.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("settings-providerextramodels");

before(() => {
    registerBuiltinMethods();
});

function makeServer(track: { pushes: unknown[][]; broadcasts: number }) {
    return {
        providerKeyStore: undefined,
        setProviderModelEdits(extras: unknown, hidden: unknown): void {
            track.pushes.push([extras, hidden]);
        },
        broadcastModelsChanged(): void {
            track.broadcasts++;
        },
    };
}

describe("settings.write — providerExtraModels push", () => {
    it("persists providerExtraModels and calls server.setProviderModelEdits", async () => {
        const track = { pushes: [] as unknown[][], broadcasts: 0 };
        await callMethod("settings.write", {
            server: makeServer(track),
            params: { global: { providerExtraModels: { minimax: [{ id: "MiniMax-M3.1" }] } } },
        });

        assert.deepEqual(readGlobalConfig().providerExtraModels, {
            minimax: [{ id: "MiniMax-M3.1" }],
        });
        assert.equal(track.pushes.length, 1);
        // Both halves travel together so the registry wrapper never loses one.
        assert.deepEqual(track.pushes[0], [{ minimax: [{ id: "MiniMax-M3.1" }] }, {}]);
        assert.ok(track.broadcasts > 0, "models.changed broadcast fired");
    });

    it("whole-object replace: a second write replaces the first", async () => {
        const track = { pushes: [] as unknown[][], broadcasts: 0 };
        await callMethod("settings.write", {
            server: makeServer(track),
            params: { global: { providerExtraModels: { deepseek: [{ id: "d-1" }] } } },
        });
        assert.deepEqual(readGlobalConfig().providerExtraModels, { deepseek: [{ id: "d-1" }] });
    });

    it("settings.get view passes providerExtraModels through", async () => {
        const result = (await callMethod("settings.get", { server: {} })) as {
            global: { providerExtraModels?: unknown };
        };
        assert.deepEqual(result.global.providerExtraModels, { deepseek: [{ id: "d-1" }] });
    });

    it("rejects custom: prefixed provider ids", async () => {
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    server: makeServer({ pushes: [], broadcasts: 0 }),
                    params: { global: { providerExtraModels: { "custom:x": [{ id: "m" }] } } },
                }),
            /custom provider/,
        );
    });

    it("rejects empty model arrays and duplicate model ids", async () => {
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    server: makeServer({ pushes: [], broadcasts: 0 }),
                    params: { global: { providerExtraModels: { minimax: [] } } },
                }),
            /non-empty array/,
        );
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    server: makeServer({ pushes: [], broadcasts: 0 }),
                    params: {
                        global: { providerExtraModels: { minimax: [{ id: "m" }, { id: "m" }] } },
                    },
                }),
            /duplicate model id/,
        );
    });

    it("does NOT call setProviderModelEdits when patch omits both maps", async () => {
        const track = { pushes: [] as unknown[][], broadcasts: 0 };
        await callMethod("settings.write", {
            server: makeServer(track),
            params: { global: { defaultModel: "m-x" } },
        });
        assert.equal(track.pushes.length, 0);
    });
});

describe("settings.write — providerHiddenModels push", () => {
    it("persists providerHiddenModels and pushes it with the current extras", async () => {
        const track = { pushes: [] as unknown[][], broadcasts: 0 };
        await callMethod("settings.write", {
            server: makeServer(track),
            params: { global: { providerHiddenModels: { minimax: ["MiniMax-M2"] } } },
        });

        assert.deepEqual(readGlobalConfig().providerHiddenModels, { minimax: ["MiniMax-M2"] });
        assert.equal(track.pushes.length, 1);
        // Extras unchanged by this patch still ride along — the registry
        // applies hide + extras in one wrapper.
        assert.deepEqual(track.pushes[0], [
            { deepseek: [{ id: "d-1" }] },
            { minimax: ["MiniMax-M2"] },
        ]);
    });

    it("settings.get view passes providerHiddenModels through", async () => {
        const result = (await callMethod("settings.get", { server: {} })) as {
            global: { providerHiddenModels?: unknown };
        };
        assert.deepEqual(result.global.providerHiddenModels, { minimax: ["MiniMax-M2"] });
    });

    it("rejects custom: prefixed provider ids and empty arrays", async () => {
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    server: makeServer({ pushes: [], broadcasts: 0 }),
                    params: { global: { providerHiddenModels: { "custom:x": ["m"] } } },
                }),
            /custom provider/,
        );
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    server: makeServer({ pushes: [], broadcasts: 0 }),
                    params: { global: { providerHiddenModels: { minimax: [] } } },
                }),
            /non-empty array/,
        );
    });
});

describe("providers.revealKey", () => {
    it("returns the plaintext key from the provider key store", async () => {
        const server = {
            providerKeyStore: {
                get: (id: string) => (id === "minimax" ? "sk-plain-text" : undefined),
            },
        };
        const result = (await callMethod("providers.revealKey", {
            server,
            params: { workspace: "/tmp/ws", providerId: "minimax" },
        })) as { key: string | null };
        assert.equal(result.key, "sk-plain-text");
    });

    it("returns null when no key is configured", async () => {
        const server = { providerKeyStore: { get: () => undefined } };
        const result = (await callMethod("providers.revealKey", {
            server,
            params: { workspace: "/tmp/ws", providerId: "nope" },
        })) as { key: string | null };
        assert.equal(result.key, null);
    });

    it("rejects an empty providerId with invalid_params", async () => {
        await assert.rejects(
            () =>
                callMethod("providers.revealKey", {
                    server: { providerKeyStore: { get: () => undefined } },
                    params: { workspace: "/tmp/ws", providerId: " " },
                }),
            /providerId/,
        );
    });
});
