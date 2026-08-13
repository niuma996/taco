/**
 * settings.write handler — customProviders push path:
 *   when patch includes customProviders, the handler calls server.setCustomProviders
 *   so existing workspace catalogs are reconciled in real time (add/delete custom ids;
 *   builtin providers untouched).
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.customProviders.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-customproviders-"));
    process.env.TACO_HOME = tmpDir;
    registerBuiltinMethods();
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
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
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

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
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            params: { global: { customProviders: [CUSTOM_A] } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);

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
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const received: unknown[][] = [];
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(next: readonly unknown[]): void {
                received.push([...next]);
            },
            broadcastModelsChanged(): void {},
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            params: { global: { customProviders: [CUSTOM_B] } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);

        assert.equal(received.length, 1);
        const ids = (received[0] as Array<{ id: string }>).map((c) => c.id);
        assert.deepEqual(ids, ["custom:relay-b"]);
    });

    it("does NOT call setCustomProviders when patch omits customProviders", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        let pushCount = 0;
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(): void {
                pushCount++;
            },
            broadcastModelsChanged(): void {},
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            // Only changing defaultModel, not touching customProviders
            params: { global: { defaultModel: "anthropic/claude-x" } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);
        assert.equal(pushCount, 0, "unrelated fields must not trigger push");
    });

    it("empty array is a valid push (clears customs)", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        let pushCount = 0;
        const server = {
            providerKeyStore: undefined,
            setCustomProviders(next: readonly unknown[]): void {
                pushCount++;
                assert.equal(next.length, 0);
            },
            broadcastModelsChanged(): void {},
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            params: { global: { customProviders: [] } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);
        assert.equal(pushCount, 1);
        assert.deepEqual(readGlobalConfig().customProviders, []);
    });
});
