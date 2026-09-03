import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { ChannelsListResult } from "@taco-ai/protocol";
import type { ChannelControl, ServerRpcSurface } from "../../../src/runtime/serverRpcSurface.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

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

async function call(method: string, server: ServerRpcSurface, params: unknown): Promise<unknown> {
    const reg = getRegisteredMethod(method);
    assert.ok(reg, `method not registered: ${method}`);
    return await reg.handler({ id: "1", server, params } as never);
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
        await call("channels.create", hook(control), { name: "wechat", channelId: "wechat-work" });

        assert.deepEqual(calls.create, [{ name: "wechat", channelId: "wechat-work" }]);
    });

    it("rejects a missing name", async () => {
        const { control } = fakeChannels();
        await assert.rejects(call("channels.create", hook(control), {}), /name is required/);
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
        await assert.rejects(call("channels.bind", hook(control), {}), /channelId is required/);
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
            /requestId is required/,
        );
        await assert.rejects(
            call("channels.submitVerifyCode", hook(control), { requestId: "r1" }),
            /code is required/,
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
        await assert.rejects(call("channels.unbind", hook(control), {}), /channelId is required/);
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
        await assert.rejects(call("channels.retry", hook(control), {}), /channelId is required/);
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

    it("treats an empty-string channelId as undefined", async () => {
        // Defensive against clients that send channelId="" when they mean "all".
        const { control, calls } = fakeChannels();
        await call("channels.listConversations", hook(control), { channelId: "" });
        assert.deepEqual(calls.listConversations, [undefined]);
    });

    it("fails with invalid_state when channels are unavailable", async () => {
        await assert.rejects(
            call("channels.listConversations", hook(undefined), {}),
            /not available/,
        );
    });
});
