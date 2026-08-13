import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { ImPolicyGetResult, ImRoute, ImWorkspacePolicyPatch } from "@taco-ai/protocol";
import type { ImPolicyControl, ServerRpcSurface } from "../../../src/runtime/serverRpcSurface.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

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
        get: (params) => {
            calls.get.push(params);
            const result: ImPolicyGetResult = {
                channelId: params.channelId,
                channelDefault: {},
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
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

async function call(method: string, server: ServerRpcSurface, params: unknown): Promise<unknown> {
    const reg = getRegisteredMethod(method);
    assert.ok(reg, `method not registered: ${method}`);
    return await reg.handler({ id: "1", server, params } as never);
}

describe("imPolicy.get", () => {
    it("forwards channelId to the control surface and returns its result", async () => {
        const { control, calls } = fakeImPolicy();
        const result = await call("imPolicy.get", hook(control), { channelId: "wechat" });

        assert.deepEqual(calls.get, [{ channelId: "wechat" }]);
        assert.deepEqual(result, {
            channelId: "wechat",
            channelDefault: {},
            resolved: {
                tools: { fsTools: "deny", shell: "deny" },
                commands: { mode: "ask" },
            },
            chatOverride: null,
            hasOverride: false,
            overrides: [],
        });
    });

    it("rejects a missing channelId", async () => {
        const { control } = fakeImPolicy();
        await assert.rejects(call("imPolicy.get", hook(control), {}), /channelId is required/);
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

    it("defaults an absent patch to {}", async () => {
        const { control, calls } = fakeImPolicy();
        await call("imPolicy.setChannelDefault", hook(control), { channelId: "wechat" });
        assert.deepEqual(calls.setChannelDefault, [{ channelId: "wechat", patch: {} }]);
    });

    it("rejects a missing channelId", async () => {
        const { control } = fakeImPolicy();
        await assert.rejects(
            call("imPolicy.setChannelDefault", hook(control), {}),
            /channelId is required/,
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
            call("imPolicy.setChatOverride", hook(control), { channelId: "wechat", chatId: "c1" }),
            /peerId is required/,
        );
    });

    it("rejects a missing chatId", async () => {
        const { control } = fakeImPolicy();
        await assert.rejects(
            call("imPolicy.setChatOverride", hook(control), { channelId: "wechat", peerId: "u1" }),
            /chatId is required/,
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
