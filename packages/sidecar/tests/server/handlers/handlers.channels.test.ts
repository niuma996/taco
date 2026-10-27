/** Consolidated from 3 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type {
    ChannelsListResult,
    ImPolicyGetResult,
    ImRoute,
    ImWorkspacePolicyPatch,
} from "@taco-ai/protocol";
import {
    WechatSdkMissingError,
    WecomSdkMissingError,
} from "../../../src/channels/channelFactory.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import type {
    ChannelControl,
    ImPolicyControl,
    ServerRpcSurface,
} from "../../../src/runtime/serverRpcSurface.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

describe("channels.bind", () => {
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
});

describe("channels", () => {
    before(() => {
        registerBuiltinMethods();
    });

    interface CallLog {
        bind: { channelId: string; force?: boolean }[];
        unbind: string[];
        verify: { requestId: string; code: string }[];
        create: { name: string; channelId?: string }[];
        listConversations: (string | undefined)[];
        retry: string[];
    }

    function fakeChannels(overrides: Partial<ChannelControl> = {}): {
        control: ChannelControl;
        calls: CallLog;
    } {
        const calls: CallLog = {
            bind: [],
            unbind: [],
            verify: [],
            create: [],
            listConversations: [],
            retry: [],
        };
        const control: ChannelControl = {
            create: (name, channelId) => {
                calls.create.push({ name, channelId });
                return { channelId: channelId ?? name, requiresRestart: true };
            },
            list: () => ({
                available: [
                    {
                        name: "wechat",
                        version: "0.1.0",
                        maxMessageLength: 2048,
                        requiresPersistentProcess: true,
                        approvalButton: false,
                    },
                ],
                configured: [
                    { channelId: "wechat", name: "wechat", state: "connected", configured: true },
                ],
                failed: [],
            }),
            listConversations: (channelId) => {
                calls.listConversations.push(channelId);
                return { conversations: [] };
            },
            bind: async (channelId, force) => {
                calls.bind.push({ channelId, force });
                return { channelId, state: "awaiting_scan" };
            },
            submitVerifyCode: (requestId, code) => {
                calls.verify.push({ requestId, code });
                return true;
            },
            unbind: async (channelId) => {
                calls.unbind.push(channelId);
            },
            retry: async (channelId) => {
                calls.retry.push(channelId);
                return { channelId, state: "connecting" };
            },
            ...overrides,
        };
        return { control, calls };
    }

    function hook(channels?: ChannelControl): ServerRpcSurface {
        return { channels } as unknown as ServerRpcSurface;
    }

    async function call(
        method: string,
        server: ServerRpcSurface,
        params: unknown,
    ): Promise<unknown> {
        return await callMethod(method, { server, params });
    }

    describe("channels.list", () => {
        it("returns available types and configured instances", async () => {
            const { control } = fakeChannels();
            const result = (await call("channels.list", hook(control), {})) as ChannelsListResult;

            assert.equal(result.available[0].name, "wechat");
            assert.equal(result.configured[0].channelId, "wechat");
            assert.equal(result.configured[0].state, "connected");
        });

        it("never exposes a credential value", async () => {
            // A leak would most likely arrive as a token/credential-ish key, so
            // assert on the serialized payload rather than a known field name.
            const { control } = fakeChannels();
            const result = await call("channels.list", hook(control), {});
            const json = JSON.stringify(result);

            for (const forbidden of ["token", "credential", "secret", "aeskey"]) {
                assert.equal(
                    json.toLowerCase().includes(forbidden),
                    false,
                    `result leaked "${forbidden}": ${json}`,
                );
            }
            assert.equal(typeof (result as ChannelsListResult).configured[0].configured, "boolean");
        });

        it("fails with invalid_state when channels are unavailable", async () => {
            await assert.rejects(call("channels.list", hook(undefined), {}), /not available/);
        });
    });

    describe("channels.create", () => {
        it("creates an instance and reports that a restart is needed", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.create", hook(control), { name: "wechat" });

            assert.deepEqual(calls.create, [{ name: "wechat", channelId: undefined }]);
            assert.deepEqual(result, { channelId: "wechat", requiresRestart: true });
        });

        it("passes an explicit channelId through", async () => {
            const { control, calls } = fakeChannels();
            await call("channels.create", hook(control), {
                name: "wechat",
                channelId: "wechat-work",
            });

            assert.deepEqual(calls.create, [{ name: "wechat", channelId: "wechat-work" }]);
        });

        it("rejects a missing name", async () => {
            const { control } = fakeChannels();
            await assert.rejects(
                call("channels.create", hook(control), {}),
                /parameter validation failed/,
            );
        });

        it("surfaces a duplicate channelId as a caller error", async () => {
            const { control } = fakeChannels({
                create: () => {
                    throw new Error("channelId already exists: wechat");
                },
            });
            await assert.rejects(
                call("channels.create", hook(control), { name: "wechat" }),
                /already exists/,
            );
        });
    });

    describe("channels.bind", () => {
        it("forwards channelId and force to the control surface", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.bind", hook(control), {
                channelId: "wechat",
                force: true,
            });

            assert.deepEqual(calls.bind, [{ channelId: "wechat", force: true }]);
            assert.deepEqual(result, { channelId: "wechat", state: "awaiting_scan" });
        });

        it("rejects a missing channelId", async () => {
            const { control } = fakeChannels();
            await assert.rejects(
                call("channels.bind", hook(control), {}),
                /parameter validation failed/,
            );
        });

        it("surfaces an unknown channel as a caller error, not internal", async () => {
            const { control } = fakeChannels({
                bind: async () => {
                    throw new Error("unknown channelId: nope");
                },
            });
            await assert.rejects(
                call("channels.bind", hook(control), { channelId: "nope" }),
                /unknown channelId/,
            );
        });
    });

    describe("channels.submitVerifyCode", () => {
        it("passes the code through and reports acceptance", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.submitVerifyCode", hook(control), {
                requestId: "r1",
                code: "123456",
            });

            assert.deepEqual(calls.verify, [{ requestId: "r1", code: "123456" }]);
            assert.deepEqual(result, { accepted: true });
        });

        it("reports accepted=false for an expired request", async () => {
            const { control } = fakeChannels({ submitVerifyCode: () => false });
            const result = await call("channels.submitVerifyCode", hook(control), {
                requestId: "gone",
                code: "123456",
            });

            assert.deepEqual(result, { accepted: false });
        });

        it("rejects missing requestId or code", async () => {
            const { control } = fakeChannels();
            await assert.rejects(
                call("channels.submitVerifyCode", hook(control), { code: "1" }),
                /requestId/,
            );
            await assert.rejects(
                call("channels.submitVerifyCode", hook(control), { requestId: "r1" }),
                /code/,
            );
        });
    });

    describe("channels.unbind", () => {
        it("delegates to the control surface", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.unbind", hook(control), { channelId: "wechat" });

            assert.deepEqual(calls.unbind, ["wechat"]);
            assert.deepEqual(result, { channelId: "wechat" });
        });

        it("rejects a missing channelId", async () => {
            const { control } = fakeChannels();
            await assert.rejects(call("channels.unbind", hook(control), {}), /channelId/);
        });
    });

    describe("channels.retry", () => {
        it("forwards channelId to the control surface and returns the new state", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.retry", hook(control), { channelId: "wecom" });
            assert.deepEqual(calls.retry, ["wecom"]);
            assert.deepEqual(result, { channelId: "wecom", state: "connecting" });
        });

        it("rejects a missing channelId", async () => {
            const { control } = fakeChannels();
            await assert.rejects(call("channels.retry", hook(control), {}), /channelId/);
        });

        it("surfaces a control-side error as invalid_params", async () => {
            const { control } = fakeChannels({
                retry: async () => {
                    throw new Error("wecom retry requires stored botId and secret — bind first");
                },
            });
            await assert.rejects(
                call("channels.retry", hook(control), { channelId: "wecom" }),
                /requires stored botId and secret/,
            );
        });
    });

    describe("channels.listConversations", () => {
        it("forwards the channelId filter", async () => {
            const { control, calls } = fakeChannels();
            const result = await call("channels.listConversations", hook(control), {
                channelId: "wechat",
            });
            assert.deepEqual(calls.listConversations, ["wechat"]);
            assert.deepEqual(result, { conversations: [] });
        });

        it("treats an omitted channelId as undefined (no filter)", async () => {
            const { control, calls } = fakeChannels();
            await call("channels.listConversations", hook(control), {});
            assert.deepEqual(calls.listConversations, [undefined]);
        });

        it("rejects an empty-string channelId", async () => {
            // The schema requires a non-empty channel id, so a client that
            // sends "" to mean "all" is rejected at the wire boundary.
            const { control } = fakeChannels();
            await assert.rejects(
                call("channels.listConversations", hook(control), { channelId: "" }),
                /channelId/,
            );
        });

        it("fails with invalid_state when channels are unavailable", async () => {
            await assert.rejects(
                call("channels.listConversations", hook(undefined), {}),
                /not available/,
            );
        });
    });
});

describe("imPolicy", () => {
    before(() => {
        registerBuiltinMethods();
    });

    interface CallLog {
        get: unknown[];
        setChannelDefault: { channelId: string; patch: ImWorkspacePolicyPatch }[];
        setChatOverride: { route: ImRoute; patch: ImWorkspacePolicyPatch }[];
        clearChatOverride: ({ route: ImRoute } | { chatKey: string })[];
    }

    function fakeImPolicy(overrides: Partial<ImPolicyControl> = {}): {
        control: ImPolicyControl;
        calls: CallLog;
    } {
        const calls: CallLog = {
            get: [],
            setChannelDefault: [],
            setChatOverride: [],
            clearChatOverride: [],
        };
        const control: ImPolicyControl = {
            get: async (params) => {
                calls.get.push(params);
                const result: ImPolicyGetResult = {
                    channelId: params.channelId,
                    scope: params.peerId && params.chatId ? "chat" : "channel",
                    channelDefault: {},
                    resolved: {
                        tools: { fsTools: "deny", shell: "deny" },
                        commands: { mode: "ask" },
                        executionDir: { mode: "shared" },
                    },
                    chatOverride: null,
                    hasOverride: false,
                    overrides: [],
                    sources: {
                        fsTools: {
                            value: "deny",
                            source: "default",
                            inherited: { value: "deny", source: "default" },
                        },
                        shell: {
                            value: "deny",
                            source: "default",
                            inherited: { value: "deny", source: "default" },
                        },
                        commandMode: {
                            value: "ask",
                            source: "default",
                            inherited: { value: "ask", source: "default" },
                        },
                        executionDir: {
                            value: { mode: "shared" },
                            source: "default",
                            inherited: { value: { mode: "shared" }, source: "default" },
                        },
                    },
                    rules: { allow: [], deny: [] },
                };
                return result;
            },
            setChannelDefault: async (channelId, patch) => {
                calls.setChannelDefault.push({ channelId, patch });
            },
            setChatOverride: async (route, patch) => {
                calls.setChatOverride.push({ route, patch });
            },
            clearChatOverride: async (input) => {
                calls.clearChatOverride.push(input);
            },
            ...overrides,
        };
        return { control, calls };
    }

    function hook(imPolicy?: ImPolicyControl): ServerRpcSurface {
        return { imPolicy } as unknown as ServerRpcSurface;
    }

    async function call(
        method: string,
        server: ServerRpcSurface,
        params: unknown,
    ): Promise<unknown> {
        return await callMethod(method, { server, params });
    }

    describe("imPolicy.get", () => {
        it("forwards channelId to the control surface and returns its result", async () => {
            const { control, calls } = fakeImPolicy();
            const result = await call("imPolicy.get", hook(control), { channelId: "wechat" });

            assert.deepEqual(calls.get, [{ channelId: "wechat" }]);
            assert.deepEqual(result, {
                channelId: "wechat",
                scope: "channel",
                channelDefault: {},
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                    executionDir: { mode: "shared" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
                sources: {
                    fsTools: {
                        value: "deny",
                        source: "default",
                        inherited: { value: "deny", source: "default" },
                    },
                    shell: {
                        value: "deny",
                        source: "default",
                        inherited: { value: "deny", source: "default" },
                    },
                    commandMode: {
                        value: "ask",
                        source: "default",
                        inherited: { value: "ask", source: "default" },
                    },
                    executionDir: {
                        value: { mode: "shared" },
                        source: "default",
                        inherited: { value: { mode: "shared" }, source: "default" },
                    },
                },
                rules: { allow: [], deny: [] },
            });
        });

        it("rejects a missing channelId", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(call("imPolicy.get", hook(control), {}), /channelId/);
        });

        it("fails with invalid_state when imPolicy is unavailable", async () => {
            await assert.rejects(
                call("imPolicy.get", hook(undefined), { channelId: "wechat" }),
                /not available/,
            );
        });
    });

    describe("imPolicy.setChannelDefault", () => {
        it("forwards channelId + patch to the control surface", async () => {
            const { control, calls } = fakeImPolicy();
            const patch: ImWorkspacePolicyPatch = { tools: { shell: "allow" } };
            const result = await call("imPolicy.setChannelDefault", hook(control), {
                channelId: "wechat",
                patch,
            });

            assert.deepEqual(calls.setChannelDefault, [{ channelId: "wechat", patch }]);
            assert.deepEqual(result, { channelId: "wechat" });
        });

        it("rejects an absent patch", async () => {
            // The contract schema requires the patch body, so an absent one
            // never reaches the handler.
            const { control, calls } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.setChannelDefault", hook(control), { channelId: "wechat" }),
                /patch/,
            );
            assert.deepEqual(calls.setChannelDefault, []);
        });

        it("rejects a missing channelId", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.setChannelDefault", hook(control), {}),
                /channelId/,
            );
        });

        it("maps a store validation error to invalid_params (not internal)", async () => {
            const { control } = fakeImPolicy({
                setChannelDefault: async () => {
                    throw new Error("invalid im policy tools.shell from channel-default: maybe");
                },
            });
            await assert.rejects(
                call("imPolicy.setChannelDefault", hook(control), {
                    channelId: "wechat",
                    patch: { tools: { shell: "maybe" } },
                }),
                /tools.shell/,
            );
        });
    });

    describe("imPolicy.setChatOverride", () => {
        it("requires peerId and chatId alongside channelId", async () => {
            const { control, calls } = fakeImPolicy();
            const result = await call("imPolicy.setChatOverride", hook(control), {
                channelId: "wechat",
                peerId: "u1",
                chatId: "c1",
                patch: { perChatScratch: true },
            });

            assert.deepEqual(calls.setChatOverride, [
                {
                    route: { channelId: "wechat", peerId: "u1", chatId: "c1" },
                    patch: { perChatScratch: true },
                },
            ]);
            assert.deepEqual(result, { channelId: "wechat" });
        });

        it("rejects a missing peerId", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.setChatOverride", hook(control), {
                    channelId: "wechat",
                    chatId: "c1",
                }),
                /peerId/,
            );
        });

        it("rejects a missing chatId", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.setChatOverride", hook(control), {
                    channelId: "wechat",
                    peerId: "u1",
                }),
                /chatId/,
            );
        });

        it("maps a store validation error to invalid_params", async () => {
            const { control } = fakeImPolicy({
                setChatOverride: async () => {
                    throw new Error("invalid im policy commands.mode from chat-override: yolo");
                },
            });
            await assert.rejects(
                call("imPolicy.setChatOverride", hook(control), {
                    channelId: "wechat",
                    peerId: "u1",
                    chatId: "c1",
                    patch: { commands: { mode: "yolo" } },
                }),
                /commands.mode/,
            );
        });
    });

    describe("imPolicy.clearChatOverride", () => {
        it("forwards route to the control surface", async () => {
            const { control, calls } = fakeImPolicy();
            const result = await call("imPolicy.clearChatOverride", hook(control), {
                channelId: "wechat",
                peerId: "u1",
                chatId: "c1",
            });

            assert.deepEqual(calls.clearChatOverride, [
                { route: { channelId: "wechat", peerId: "u1", chatId: "c1" } },
            ]);
            assert.deepEqual(result, { channelId: "wechat" });
        });

        it("forwards chatKey when clearing an orphan override", async () => {
            const { control, calls } = fakeImPolicy();
            const orphanKey = "a".repeat(64);
            const result = await call("imPolicy.clearChatOverride", hook(control), {
                channelId: "wechat",
                chatKey: orphanKey,
            });

            assert.deepEqual(calls.clearChatOverride, [{ chatKey: orphanKey }]);
            assert.deepEqual(result, { channelId: "wechat" });
        });

        it("rejects an ambiguous (or empty) input", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.clearChatOverride", hook(control), { channelId: "wechat" }),
                /peerId\+chatId.*chatKey/,
            );
            await assert.rejects(
                call("imPolicy.clearChatOverride", hook(control), {
                    channelId: "wechat",
                    peerId: "u1",
                    chatId: "c1",
                    chatKey: "a".repeat(64),
                }),
                /peerId\+chatId.*chatKey/,
            );
        });

        it("rejects a missing chatId", async () => {
            const { control } = fakeImPolicy();
            await assert.rejects(
                call("imPolicy.clearChatOverride", hook(control), {
                    channelId: "wechat",
                    peerId: "u1",
                }),
                /peerId\+chatId.*chatKey/,
            );
        });
    });
});
