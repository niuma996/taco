/**
 * channels.bind SDK-missing error regression test.
 *
 * Verifies that when ChannelFactory.create throws WechatSdkMissingError or
 * WecomSdkMissingError (SDK missing for the corresponding channel),
 * channels.bind surfaces the error as the coded error code
 * ("wechat_sdk_missing" / "wecom_sdk_missing") — not "invalid_params" —
 * through the real dispatchRpc path where normalizeError operates.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/channels.bind.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import {
    WechatSdkMissingError,
    WecomSdkMissingError,
} from "../../../src/channels/channelFactory.ts";
import { ProviderKeyStore } from "../../../src/runtime/providerKeyStore.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";

before(() => {
    registerBuiltinMethods();
});

function dispatch(
    server: SidecarServer,
    method: string,
    params: unknown,
): Promise<{ ok: boolean; error?: { code: string; message?: string } }> {
    return server.dispatchRpc({ id: "reg-test", method, params });
}

describe("channels.bind error codes through dispatchRpc", () => {
    it("WechatSdkMissingError → code wechat_sdk_missing", async () => {
        // Arrange: inject a channel hook whose bind throws WechatSdkMissingError,
        // simulating what ChannelFactory.create produces when the SDK is absent.
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        // @ts-expect-error — channels is not on the public ServerRpcSurface surface,
        // but the handler accesses server.channels which is typed ServerRpcSurface.
        server.channels = {
            bind: async () => {
                throw new WechatSdkMissingError(null);
            },
        } as never;

        // Act
        const resp = await dispatch(server, "channels.bind", { channelId: "wechat" });

        // Assert
        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "wechat_sdk_missing");
        assert.ok(
            resp.error?.message?.includes("@wechatbot/wechatbot"),
            "message should include the SDK install hint",
        );
    });

    it("WecomSdkMissingError → code wecom_sdk_missing", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        // @ts-expect-error — see above
        server.channels = {
            bind: async () => {
                throw new WecomSdkMissingError(null);
            },
        } as never;

        const resp = await dispatch(server, "channels.bind", { channelId: "wecom" });

        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "wecom_sdk_missing");
        assert.ok(
            resp.error?.message?.includes("@wecom/aibot-node-sdk"),
            "message should include the SDK install hint",
        );
    });

    it("unknown channelId → code invalid_params (existing behaviour preserved)", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        // @ts-expect-error — see above
        server.channels = {
            bind: async () => {
                throw new Error("unknown channelId: nope");
            },
        } as never;

        const resp = await dispatch(server, "channels.bind", { channelId: "nope" });

        assert.equal(resp.ok, false);
        assert.equal(resp.error?.code, "invalid_params");
    });
});
