/**
 * settings.write handler — broadcastModelsChanged trigger conditions:
 *  broadcasts only when the patch contains apiKeys or customProviders;
 *  unrelated fields (defaultModel, compaction, etc.) do not trigger it.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.broadcastModelsChanged.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ProviderKeyStore } from "../../../src/runtime/providerKeyStore.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-broadcast-"));
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

type HandlerCtx = Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];

function makeCtx(server: unknown, global: Record<string, unknown>): HandlerCtx {
    return {
        id: "test",
        workspace: undefined as never,
        cwd: undefined as never,
        server,
        params: { global },
    } as unknown as HandlerCtx;
}

describe("settings.write — broadcastModelsChanged trigger", () => {
    it("broadcasts once when apiKeys changes", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);
        const { server, getCalls } = makeServer();
        await reg.handler(makeCtx(server, { apiKeys: { anthropic: "sk-ant-test123" } }));
        assert.equal(getCalls(), 1);
    });

    it("broadcasts once when customProviders changes", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);
        const { server, getCalls } = makeServer();
        await reg.handler(makeCtx(server, { customProviders: [] }));
        assert.equal(getCalls(), 1);
    });

    it("does NOT broadcast when patch touches only unrelated fields", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);
        const { server, getCalls } = makeServer();
        await reg.handler(makeCtx(server, { defaultModel: "anthropic/claude-x" }));
        assert.equal(getCalls(), 0, "defaultModel-only patch must not broadcast");
    });
});
