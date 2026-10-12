/**
 * settings.write handler — customProviders push path:
 *   when patch includes customProviders, the handler calls server.setCustomProviders
 *   so existing workspace catalogs are reconciled in real time (add/delete custom ids;
 *   builtin providers untouched).
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.customProviders.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("settings-customproviders");

before(() => {
    registerBuiltinMethods();
});

const CUSTOM_A = {
    id: "custom:relay-a",
    name: "Relay A",
    api: "chatcomplete" as const,
    baseUrl: "https://relay-a.example.com/v1",
    models: [{ id: "m1" }, { id: "m2" }],
};

const CUSTOM_B = {
    id: "custom:relay-b",
    name: "Relay B",
    api: "anthropic" as const,
    baseUrl: "https://relay-b.example.com",
    models: [{ id: "claude-relay" }],
};

describe("settings.write — customProviders push", () => {
    it("persists customProviders and calls server.setCustomProviders", async () => {
        let pushCount = 0;
        let lastReceived: readonly unknown[] | undefined;
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(next: readonly unknown[]): void {
                pushCount++;
                lastReceived = next;
            },
            broadcastModelsChanged(): void {},
        };
        await callMethod("settings.write", {
            server,
            params: { global: { customProviders: [CUSTOM_A] } },
        });

        // Disk persisted
        const onDisk = readGlobalConfig();
        assert.deepEqual(
            onDisk.customProviders?.map((c) => c.id),
            ["custom:relay-a"],
        );
        // server received push
        assert.equal(pushCount, 1);
        assert.equal((lastReceived?.[0] as { id: string }).id, "custom:relay-a");
    });

    it("replace: old custom deleted, new custom upserted via single push", async () => {
        const received: unknown[][] = [];
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(next: readonly unknown[]): void {
                received.push([...next]);
            },
            broadcastModelsChanged(): void {},
        };
        await callMethod("settings.write", {
            server,
            params: { global: { customProviders: [CUSTOM_B] } },
        });

        assert.equal(received.length, 1);
        const ids = (received[0] as Array<{ id: string }>).map((c) => c.id);
        assert.deepEqual(ids, ["custom:relay-b"]);
    });

    it("does NOT call setCustomProviders when patch omits customProviders", async () => {
        let pushCount = 0;
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(): void {
                pushCount++;
            },
            broadcastModelsChanged(): void {},
        };
        // Only changing defaultModel, not touching customProviders
        await callMethod("settings.write", {
            server,
            params: { global: { defaultModel: "anthropic/claude-x" } },
        });
        assert.equal(pushCount, 0, "unrelated fields must not trigger push");
    });

    it("empty array is a valid push (clears customs)", async () => {
        let pushCount = 0;
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(next: readonly unknown[]): void {
                pushCount++;
                assert.equal(next.length, 0);
            },
            broadcastModelsChanged(): void {},
        };
        await callMethod("settings.write", {
            server,
            params: { global: { customProviders: [] } },
        });
        assert.equal(pushCount, 1);
        assert.deepEqual(readGlobalConfig().customProviders, []);
    });
});
