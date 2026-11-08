import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MockChannel, MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import {
    type SdkLoginCallbacks,
    type WeChatBotFactoryOptions,
    WeChatChannel,
} from "../../src/channels/builtin/wechatChannel.ts";
import { WeComChannel } from "../../src/channels/builtin/wecomChannel.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import {
    CREDENTIALS_KEY,
    channelStatePath,
    FileChannelConfigStore,
    hasStoredCredentials,
} from "../../src/channels/channelConfigStore.ts";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import type { ChannelContext, ChannelHandle, Logger } from "../../src/channels/types.ts";

type BindingStore = FileChannelConfigStore & {
    getDeliveryBinding?: () => string | undefined;
    ensureDeliveryBinding?: () => Promise<void>;
};

function binding(store: BindingStore): string | undefined {
    assert.equal(typeof store.getDeliveryBinding, "function");
    return store.getDeliveryBinding?.();
}

async function ensure(store: BindingStore): Promise<void> {
    assert.equal(typeof store.ensureDeliveryBinding, "function");
    await store.ensureDeliveryBinding?.();
}

describe("channel delivery binding", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "taco-channel-binding-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("does not bind a channel without credentials", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        await ensure(store);
        assert.equal(binding(store), undefined);
        await store.set("cursor", "cursor-1");
        assert.equal(binding(store), undefined);
    });

    for (const [name, initial, refreshed, changed] of [
        [
            "wechat",
            { accountId: "account-a", baseUrl: "https://one.example", token: "token-a" },
            { accountId: "account-a", baseUrl: "https://one.example", token: "token-b" },
            { accountId: "account-b", baseUrl: "https://one.example", token: "token-b" },
        ],
        [
            "wecom",
            { botId: "bot-a", secret: "secret-a" },
            { botId: "bot-a", secret: "secret-b" },
            { botId: "bot-b", secret: "secret-b" },
        ],
    ] as const) {
        it(`${name} preserves binding across token refresh and changes it for another account`, async () => {
            const store = new FileChannelConfigStore(name, {}, home);
            await store.set(CREDENTIALS_KEY, initial);
            const original = binding(store);
            assert.match(original ?? "", /^[0-9a-f-]{36}$/);
            await store.set(CREDENTIALS_KEY, refreshed);
            assert.equal(binding(store), original);
            await store.set(CREDENTIALS_KEY, changed);
            assert.notEqual(binding(store), original);
        });
    }

    it("includes the WeChat API origin in account identity", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        await store.set(CREDENTIALS_KEY, { accountId: "a", baseUrl: "https://one.example" });
        const original = binding(store);
        await store.set(CREDENTIALS_KEY, { accountId: "a", baseUrl: "https://two.example" });
        assert.notEqual(binding(store), original);
    });

    it("compares unknown credentials conservatively without rotating identical values", async () => {
        const store = new FileChannelConfigStore("custom", {}, home);
        await store.set(CREDENTIALS_KEY, { token: "a", nested: { value: 1 } });
        const original = binding(store);
        await store.set(CREDENTIALS_KEY, { nested: { value: 1 }, token: "a" });
        assert.equal(binding(store), original);
        await store.set(CREDENTIALS_KEY, { token: "b", nested: { value: 1 } });
        assert.notEqual(binding(store), original);
    });

    it("persists only an opaque generation beside the existing credential blob", async () => {
        const store = new FileChannelConfigStore("wecom", {}, home);
        const credentials = { botId: "private-bot", secret: "private-secret" };
        await store.set(CREDENTIALS_KEY, credentials);
        const persisted = JSON.parse(readFileSync(channelStatePath("wecom", home), "utf8"));
        assert.deepEqual(persisted, { credentials, deliveryBinding: binding(store) });
        assert.ok(!binding(store)?.includes("private"));
    });

    it("preserves the generation across restart and unrelated writes", async () => {
        const store = new FileChannelConfigStore("wecom", {}, home);
        await store.set(CREDENTIALS_KEY, { botId: "a", secret: "s" });
        const original = binding(store);
        const reopened = new FileChannelConfigStore("wecom", {}, home);
        await ensure(reopened);
        await reopened.set("cursor", 2);
        assert.equal(binding(reopened), original);
    });

    it("initializes legacy credentials once even with concurrent initialization", async () => {
        const file = channelStatePath("wechat", home);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ credentials: { token: "legacy" }, cursor: 7 }));
        const store = new FileChannelConfigStore("wechat", {}, home);
        assert.equal(binding(store), undefined);
        await Promise.all([ensure(store), ensure(store), store.set("other", true)]);
        const original = binding(store);
        assert.ok(original);
        const reopened = new FileChannelConfigStore("wechat", {}, home);
        await ensure(reopened);
        assert.equal(binding(reopened), original);
        assert.equal(reopened.get("cursor"), 7);
        assert.equal(reopened.get("other"), true);
    });

    for (const clearAll of [false, true]) {
        it(`${clearAll ? "clear" : "credential removal"} drops binding and rebind generates another`, async () => {
            const store = new FileChannelConfigStore("wecom", {}, home);
            const credentials = { botId: "a", secret: "s" };
            await store.set(CREDENTIALS_KEY, credentials);
            const original = binding(store);
            if (clearAll) await store.clear();
            else await store.set(CREDENTIALS_KEY, undefined);
            assert.equal(binding(store), undefined);
            const reopened = new FileChannelConfigStore("wecom", {}, home);
            await ensure(reopened);
            assert.equal(binding(reopened), undefined);
            await reopened.set(CREDENTIALS_KEY, credentials);
            assert.notEqual(binding(reopened), original);
        });
    }

    it("does not resurrect binding or credentials from seed settings after clear", async () => {
        const seed = {
            deliveryBinding: "stale-binding",
            credentials: { botId: "a", secret: "s" },
            setting: 1,
        };
        const store = new FileChannelConfigStore("wecom", seed, home);
        assert.equal(binding(store), undefined);
        await store.set(CREDENTIALS_KEY, { botId: "a", secret: "s" });
        assert.notEqual(binding(store), seed.deliveryBinding);
        await store.clear();
        assert.deepEqual(JSON.parse(readFileSync(channelStatePath("wecom", home), "utf8")), {
            credentials: null,
            setting: 1,
        });
        assert.equal(hasStoredCredentials("wecom", home), false);
        const reopened = new FileChannelConfigStore("wecom", seed, home);
        await ensure(reopened);
        assert.equal(binding(reopened), undefined);
        assert.equal(reopened.get(CREDENTIALS_KEY), undefined);
        assert.equal(reopened.get("setting"), 1);
    });

    it("serializes credential changes and binding in the same write", async () => {
        const store = new FileChannelConfigStore("wecom", {}, home);
        await Promise.all([
            store.set(CREDENTIALS_KEY, { botId: "a", secret: "s" }),
            ensure(store),
            store.set(CREDENTIALS_KEY, { botId: "b", secret: "s" }),
        ]);
        const reopened = new FileChannelConfigStore("wecom", {}, home);
        assert.equal(binding(reopened), binding(store));
        assert.deepEqual(reopened.get(CREDENTIALS_KEY), { botId: "b", secret: "s" });
    });

    it("initializes and persists seeded credentials with a fresh generation", async () => {
        const credentials = { botId: "seed-account", secret: "secret" };
        const store = new FileChannelConfigStore(
            "wecom",
            { credentials, deliveryBinding: "stale" },
            home,
        );
        await ensure(store);
        const original = binding(store);
        assert.ok(original);
        assert.notEqual(original, "stale");
        const reopened = new FileChannelConfigStore("wecom", {}, home);
        assert.equal(binding(reopened), original);
        assert.deepEqual(reopened.get(CREDENTIALS_KEY), credentials);
    });

    function context(channelId: string, config: FileChannelConfigStore): ChannelContext {
        const logger: Logger = {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            child: () => logger,
        };
        return { channelId, config, logger, ingress: { submit: async () => ({ sessionId: "s" }) } };
    }

    function liveBinding(handle: ChannelHandle): string | undefined {
        assert.equal(typeof handle.getDeliveryBinding, "function");
        return handle.getDeliveryBinding?.();
    }

    it("pins WeCom binding to the instantiated client until reconnect, even offline", async () => {
        const store = new FileChannelConfigStore("wecom", {}, home);
        await store.set(CREDENTIALS_KEY, { botId: "old", secret: "s" });
        const original = binding(store);
        const clients: EventEmitter[] = [];
        const channel = new WeComChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createClient: () => {
                const client = Object.assign(new EventEmitter(), {
                    connect: () => {},
                    disconnect: () => {},
                    sendMessage: async () => {},
                    downloadFile: async () => ({ buffer: Buffer.alloc(0) }),
                });
                clients.push(client);
                return client;
            },
        });
        const handle = await channel.start(context("wecom", store));
        try {
            assert.equal(liveBinding(handle), original);
            clients[0]?.emit("disconnected", "offline");
            assert.equal(liveBinding(handle), original);
            await store.set(CREDENTIALS_KEY, { botId: "new", secret: "s" });
            assert.equal(liveBinding(handle), original);
            await handle.retryWithStoredCreds?.();
            assert.equal(liveBinding(handle), binding(store));
            assert.notEqual(liveBinding(handle), original);
            await handle.logout?.();
            assert.equal(liveBinding(handle), undefined);
        } finally {
            await handle.close();
        }
    });

    it("updates WeChat binding only after the bot adopts credentials and preserves it offline", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        let factory: WeChatBotFactoryOptions | undefined;
        let credentials = { accountId: "old", baseUrl: "https://api.example", token: "s" };
        const bot = Object.assign(new EventEmitter(), {
            isRunning: false,
            login: async () => {
                await factory?.storage.set(CREDENTIALS_KEY, credentials);
                bot.emit("login", credentials);
            },
            start: async () => {
                bot.isRunning = true;
            },
            stop: () => {
                bot.isRunning = false;
            },
            send: async () => {},
            onMessage: () => {},
            download: async () => null,
        });
        const channel = new WeChatChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createBot: (options) => {
                factory = options;
                return bot;
            },
        });
        const handle = await channel.start(context("wechat", store));
        try {
            assert.equal(liveBinding(handle), undefined);
            await handle.login?.();
            const original = binding(store);
            assert.equal(liveBinding(handle), original);
            bot.stop();
            assert.equal(liveBinding(handle), original);
            credentials = { ...credentials, accountId: "new" };
            await store.set(CREDENTIALS_KEY, credentials);
            assert.equal(liveBinding(handle), original);
            await handle.login?.();
            assert.equal(liveBinding(handle), binding(store));
            assert.notEqual(liveBinding(handle), original);
            await handle.logout?.();
            assert.equal(liveBinding(handle), undefined);
        } finally {
            await handle.close();
        }
    });

    it("gives mock channels stable channel-specific bindings", async () => {
        const channel = new MockChannel();
        const store = new FileChannelConfigStore("mock", {}, home);
        const handle = await channel.start(context("mock-one", store));
        const other = await channel.start(context("mock-two", store));
        assert.equal(liveBinding(handle), "mock:mock-one");
        assert.equal(liveBinding(other), "mock:mock-two");
        assert.equal(liveBinding(new MockChannelHandle()), liveBinding(new MockChannelHandle()));
    });

    it("guards real WeCom login against queued delivery and preserves same-account reconnect", async () => {
        const store = new FileChannelConfigStore("wecom", {}, home);
        await store.set(CREDENTIALS_KEY, { botId: "old", secret: "s" });
        const registry = new ChannelRegistry();
        const sent: { botId: string; text: string }[] = [];
        let release!: () => void;
        let signalStarted!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
        });
        const channel = new WeComChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createClient: (options) => {
                const client = Object.assign(new EventEmitter(), {
                    connect: () => {
                        client.emit("authenticated");
                    },
                    disconnect: () => {},
                    sendMessage: async (
                        _chatId: string,
                        body: { msgtype: string; [key: string]: unknown },
                    ) => {
                        const text = (body.markdown as { content: string }).content;
                        sent.push({ botId: options.botId, text });
                        if (text === "hold") {
                            signalStarted();
                            await held;
                        }
                    },
                    downloadFile: async () => ({ buffer: Buffer.alloc(0) }),
                });
                return client;
            },
        });
        const route = { channelId: "wecom", chatId: "chat", peerId: "peer" };
        try {
            const result = await registry.loadAndStart(
                [{ channelId: "wecom", manifest: channel.manifest, config: {} }],
                () => channel,
                () => context("wecom", store),
            );
            assert.deepEqual(result.failed, []);
            const original = registry.getDeliveryBinding("wecom");
            assert.ok(original);
            const sending = registry.sendText("wecom", route, "hold", { bindingId: original });
            await started;
            const login = registry.login("wecom", false, { botId: "new", secret: "s" });
            const staleSend = registry.sendText("wecom", route, "stale", { bindingId: original });
            assert.equal(registry.getDeliveryBinding("wecom"), original);
            release();
            assert.deepEqual(await sending, { kind: "confirmed" });
            await login;
            assert.deepEqual(await staleSend, {
                kind: "permanentFailure",
                code: "binding_changed",
            });
            assert.deepEqual(sent, [{ botId: "old", text: "hold" }]);
            const current = registry.getDeliveryBinding("wecom");
            assert.ok(current);
            assert.notEqual(current, original);
            await registry.login("wecom", false, { botId: "new", secret: "refreshed" });
            assert.equal(registry.getDeliveryBinding("wecom"), current);
            assert.deepEqual(
                await registry.sendText("wecom", route, "new result", { bindingId: current }),
                { kind: "confirmed" },
            );
            assert.deepEqual(sent.at(-1), { botId: "new", text: "new result" });
        } finally {
            release();
            await registry.stopAll();
        }
    });

    for (const cleanup of ["logout", "close"] as const) {
        it(`rejects late QR credentials after ${cleanup} without restarting polling`, async () => {
            const store = new FileChannelConfigStore("wechat", {}, home);
            let release!: () => void;
            let started!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const entered = new Promise<void>((resolve) => {
                started = resolve;
            });
            let startCalls = 0;
            const channel = new WeChatChannel({
                broker: new ChannelBindBroker(),
                resolveRoute: () => undefined,
                createBot: ({ storage }) =>
                    Object.assign(new EventEmitter(), {
                        isRunning: false,
                        login: async () => {
                            started();
                            await held;
                            await storage.set(CREDENTIALS_KEY, {
                                accountId: "late",
                                baseUrl: "https://api.example",
                                token: "s",
                            });
                        },
                        start: async () => {
                            startCalls++;
                        },
                        stop: () => {},
                        send: async () => {},
                        onMessage: () => {},
                        download: async () => null,
                    }),
            });
            const handle = await channel.start(context("wechat", store));
            const login = handle.login?.();
            const rejected = assert.rejects(async () => login, /cancel|abort|clos/i);
            await entered;
            assert.equal(typeof handle.cancelBinding, "function");
            handle.cancelBinding?.();
            if (cleanup === "logout") await handle.logout?.();
            else await handle.close();
            release();
            await rejected;
            assert.equal(store.get(CREDENTIALS_KEY), undefined);
            assert.equal(binding(store), undefined);
            assert.equal(startCalls, 0);
            await handle.close();
        });
    }

    it("isolates a replacement login from a cancelled bot's late storage and callbacks", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        const broker = new ChannelBindBroker();
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const factories: WeChatBotFactoryOptions[] = [];
        const callbacks: (SdkLoginCallbacks | undefined)[] = [];
        const channel = new WeChatChannel({
            broker,
            resolveRoute: () => undefined,
            createBot: (options) => {
                const index = factories.push(options) - 1;
                const bot = Object.assign(new EventEmitter(), {
                    isRunning: false,
                    login: async (args?: { callbacks?: SdkLoginCallbacks }) => {
                        callbacks[index] = args?.callbacks;
                        if (index === 0) {
                            started();
                            await held;
                        }
                        await options.storage.set(CREDENTIALS_KEY, {
                            accountId: `account-${index}`,
                            baseUrl: "https://api.example",
                            token: "s",
                        });
                        bot.emit("login");
                    },
                    start: async () => {
                        bot.isRunning = true;
                    },
                    stop: () => {
                        bot.isRunning = false;
                    },
                    send: async () => {},
                    onMessage: () => {},
                    download: async () => null,
                });
                return bot;
            },
        });
        const handle = await channel.start(context("wechat", store));
        try {
            const first = handle.login?.();
            const rejected = assert.rejects(async () => first, /cancel|abort/i);
            await entered;
            assert.equal(typeof handle.cancelBinding, "function");
            handle.cancelBinding?.();
            await handle.login?.(true);
            const replacement = binding(store);
            assert.ok(replacement);
            assert.deepEqual(store.get(CREDENTIALS_KEY), {
                accountId: "account-1",
                baseUrl: "https://api.example",
                token: "s",
            });
            assert.throws(() => callbacks[0]?.onQrUrl("https://stale.example"), /cancel|abort/i);
            assert.notEqual(broker.status("wechat").state, "awaiting_scan");
            release();
            await rejected;
            assert.equal(binding(store), replacement);
            assert.equal(liveBinding(handle), replacement);
            await assert.rejects(
                factories[0]?.storage.delete(CREDENTIALS_KEY) ?? Promise.resolve(),
                /cancel|abort/i,
            );
            await assert.rejects(
                factories[0]?.storage.clear() ?? Promise.resolve(),
                /cancel|abort/i,
            );
            assert.equal(binding(store), replacement);
        } finally {
            release();
            await handle.close();
        }
    });

    it("retires the previous SDK's automatic auth when starting another login", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        const factories: WeChatBotFactoryOptions[] = [];
        const channel = new WeChatChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createBot: (options) => {
                const index = factories.push(options) - 1;
                return Object.assign(new EventEmitter(), {
                    isRunning: false,
                    login: async () => {
                        await options.storage.set(CREDENTIALS_KEY, {
                            accountId: `account-${index}`,
                            baseUrl: "https://api.example",
                            token: "s",
                        });
                    },
                    start: async () => {},
                    stop: () => {},
                    send: async () => {},
                    onMessage: () => {},
                    download: async () => null,
                });
            },
        });
        const handle = await channel.start(context("wechat", store));
        try {
            await handle.login?.();
            await handle.login?.(true);
            assert.equal(factories.length, 2);
            await assert.rejects(
                factories[0]?.storage.set(CREDENTIALS_KEY, {
                    accountId: "stale",
                    baseUrl: "https://api.example",
                    token: "s",
                }) ?? Promise.resolve(),
                /cancel|abort/i,
            );
            assert.deepEqual(store.get(CREDENTIALS_KEY), {
                accountId: "account-1",
                baseUrl: "https://api.example",
                token: "s",
            });
        } finally {
            await handle.close();
        }
    });

    it("releases authenticated login without awaiting the SDK's polling lifetime", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        let stopPolling!: () => void;
        const polling = new Promise<void>((resolve) => {
            stopPolling = resolve;
        });
        const channel = new WeChatChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createBot: () =>
                Object.assign(new EventEmitter(), {
                    isRunning: false,
                    login: async () => {},
                    start: () => polling,
                    stop: () => stopPolling(),
                    send: async () => {},
                    onMessage: () => {},
                    download: async () => null,
                }),
        });
        const handle = await channel.start(context("wechat", store));
        try {
            const completed = await Promise.race([
                handle.login?.().then(() => true),
                new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
            ]);
            assert.equal(completed, true);
        } finally {
            await handle.close();
        }
    });

    for (const action of ["stop", "logout"] as const) {
        it(`registry ${action} finishes while the actual WeChat QR request is still pending`, async () => {
            const store = new FileChannelConfigStore("wechat", {}, home);
            const registry = new ChannelRegistry();
            let release!: () => void;
            let started!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const entered = new Promise<void>((resolve) => {
                started = resolve;
            });
            let finished!: () => void;
            const settled = new Promise<void>((resolve) => {
                finished = resolve;
            });
            const channel = new WeChatChannel({
                broker: new ChannelBindBroker(),
                resolveRoute: () => undefined,
                createBot: ({ storage }) =>
                    Object.assign(new EventEmitter(), {
                        isRunning: false,
                        login: async () => {
                            try {
                                started();
                                await held;
                                await storage.set(CREDENTIALS_KEY, {
                                    accountId: "late",
                                    baseUrl: "https://api.example",
                                    token: "s",
                                });
                            } finally {
                                finished();
                            }
                        },
                        start: async () => assert.fail("cancelled login must not start polling"),
                        stop: () => {},
                        send: async () => {},
                        onMessage: () => {},
                        download: async () => null,
                    }),
            });
            await registry.loadAndStart(
                [{ channelId: "wechat", manifest: channel.manifest, config: {} }],
                () => channel,
                () => context("wechat", store),
            );
            const rejected = assert.rejects(registry.login("wechat"), /cancel|abort/i);
            try {
                await entered;
                await registry[action]("wechat");
                await rejected;
                assert.equal(binding(store), undefined);
                release();
                await settled;
                assert.equal(store.get(CREDENTIALS_KEY), undefined);
                assert.equal(registry.getDeliveryBinding("wechat"), undefined);
            } finally {
                release();
                await rejected;
                await registry.stopAll();
            }
        });
    }

    function deferCredentialWrite(store: FileChannelConfigStore, afterCommit = false) {
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const set = store.set.bind(store);
        let deferred = false;
        store.set = async <T>(name: string, value: T) => {
            if (name !== CREDENTIALS_KEY || deferred) return set(name, value);
            deferred = true;
            if (afterCommit) await set(name, value);
            entered();
            await held;
            if (!afterCommit) await set(name, value);
        };
        return { started, release };
    }

    for (const action of ["cancelBinding", "close", "logout", "registryStop"] as const) {
        it(`WeCom ${action} fences a login already awaiting credential persistence`, async () => {
            const store = new FileChannelConfigStore("wecom", {}, home);
            let created = 0;
            const channel = new WeComChannel({
                broker: new ChannelBindBroker(),
                resolveRoute: () => undefined,
                createClient: () => {
                    created++;
                    return Object.assign(new EventEmitter(), {
                        connect: () => {},
                        disconnect: () => {},
                        sendMessage: async () => {},
                        downloadFile: async () => ({ buffer: Buffer.alloc(0) }),
                    });
                },
            });
            const handle = await channel.start(context("wecom", store));
            const delayed = deferCredentialWrite(store, true);
            const login = handle.login?.(false, { botId: "late", secret: "s" });
            const rejected = assert.rejects(async () => login, /cancel|abort/i);
            void rejected.catch(() => {});
            try {
                await delayed.started;
                if (action === "registryStop") {
                    const registry = new ChannelRegistry();
                    registry.register("wecom", channel, handle);
                    await registry.stop("wecom");
                } else await handle[action]?.();
                delayed.release();
                await rejected;
                assert.equal(created, 0);
                assert.equal(liveBinding(handle), undefined);
            } finally {
                delayed.release();
                await Promise.allSettled([login, rejected]);
                await handle.close();
            }
        });
    }

    it("drains cancelled WeChat writes before replacement reads and adopts credentials", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        const original = { accountId: "original", baseUrl: "https://api.example", token: "c" };
        const incoming = { ...original, accountId: "committing", token: "a" };
        await store.set(CREDENTIALS_KEY, original);
        const factories: WeChatBotFactoryOptions[] = [];
        const adopted: unknown[] = [];
        const sent: unknown[] = [];
        let started!: () => void;
        const initial = new Promise<void>((resolve) => {
            started = resolve;
        });
        const channel = new WeChatChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createBot: (options) => {
                const index = factories.push(options) - 1;
                const bot = Object.assign(new EventEmitter(), {
                    isRunning: false,
                    login: async () => {
                        adopted[index] = await options.storage.get(CREDENTIALS_KEY);
                        bot.emit("login");
                    },
                    start: async () => {
                        bot.isRunning = true;
                        if (index === 0) started();
                    },
                    stop: () => {
                        bot.isRunning = false;
                    },
                    send: async () => {
                        sent.push(adopted[index]);
                    },
                    onMessage: () => {},
                    download: async () => null,
                });
                return bot;
            },
        });
        const handle = await channel.start(context("wechat", store));
        await initial;
        const delayed = deferCredentialWrite(store);
        const pending = factories[0]?.storage.set(CREDENTIALS_KEY, incoming);
        const rejected = assert.rejects(async () => pending, /cancel|abort/i);
        void rejected.catch(() => {});
        let replacement: Promise<void> | undefined;
        try {
            await delayed.started;
            handle.cancelBinding?.();
            replacement = handle.login?.();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(
                adopted.length,
                1,
                "replacement must not read credentials before old writes finish",
            );
            delayed.release();
            await rejected;
            await replacement;
            assert.deepEqual(adopted[1], incoming);
            assert.equal(liveBinding(handle), binding(store));
            assert.deepEqual(
                await handle.sendText?.(
                    { channelId: "wechat", peerId: "peer", chatId: "chat" },
                    "result",
                ),
                { kind: "confirmed" },
            );
            assert.deepEqual(sent, [incoming]);
        } finally {
            delayed.release();
            await Promise.allSettled([pending, rejected, replacement]);
            await handle.close();
        }
    });

    it("drains cancelled WeChat writes before logout clears credentials", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        let factory: WeChatBotFactoryOptions | undefined;
        const channel = new WeChatChannel({
            broker: new ChannelBindBroker(),
            resolveRoute: () => undefined,
            createBot: (options) => {
                factory = options;
                return Object.assign(new EventEmitter(), {
                    isRunning: false,
                    login: async () => {},
                    start: async () => {},
                    stop: () => {},
                    send: async () => {},
                    onMessage: () => {},
                    download: async () => null,
                });
            },
        });
        const handle = await channel.start(context("wechat", store));
        const delayed = deferCredentialWrite(store);
        const pending = factory?.storage.set(CREDENTIALS_KEY, {
            accountId: "late",
            baseUrl: "https://api.example",
            token: "s",
        });
        const rejected = assert.rejects(async () => pending, /cancel|abort/i);
        void rejected.catch(() => {});
        let cleared = false;
        const clear = store.clear.bind(store);
        store.clear = async () => {
            cleared = true;
            await clear();
        };
        let logout: Promise<void> | undefined;
        try {
            await delayed.started;
            logout = handle.logout?.();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(cleared, false, "logout must wait for already accepted storage writes");
            delayed.release();
            await rejected;
            await logout;
            assert.equal(store.get(CREDENTIALS_KEY), undefined);
            assert.equal(binding(store), undefined);
        } finally {
            delayed.release();
            await Promise.allSettled([pending, rejected, logout]);
            await handle.close();
        }
    });
});
