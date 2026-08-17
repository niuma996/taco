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
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-defaultmodel-"));
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

function makeCtx(server: unknown, global: Record<string, unknown>) {
    return {
        id: "test",
        workspace: undefined as never,
        cwd: undefined as never,
        server,
        params: { global },
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

describe("settings.write — defaultModel push", () => {
    it("persists defaultModel/defaultProvider and calls server.setDefaultModel", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const calls: DefaultModelCall[] = [];
        const server = makeServer(calls);
        await reg.handler(
            makeCtx(server, {
                defaultModel: "MiniMax-M2.7-highspeed",
                defaultProvider: "minimax-cn",
            }),
        );

        // Disk persisted
        const onDisk = readGlobalConfig();
        assert.equal(onDisk.defaultModel, "MiniMax-M2.7-highspeed");
        assert.equal(onDisk.defaultProvider, "minimax-cn");

        // server received the push with the resolved-on-disk values
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            defaultModel: "MiniMax-M2.7-highspeed",
            defaultProvider: "minimax-cn",
        });
    });

    it("fires when only defaultProvider changes (it scopes the model lookup)", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const calls: DefaultModelCall[] = [];
        const server = makeServer(calls);
        // defaultModel already on disk from the previous test; change provider only.
        await reg.handler(makeCtx(server, { defaultProvider: "minimax" }));

        assert.equal(calls.length, 1);
        assert.equal(calls[0].defaultProvider, "minimax");
    });

    it("does NOT push when the patch touches neither field", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const calls: DefaultModelCall[] = [];
        const server = makeServer(calls);
        await reg.handler(makeCtx(server, { thinkingLevel: "low" }));

        assert.equal(calls.length, 0);
    });
});
