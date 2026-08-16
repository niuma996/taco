import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    CREDENTIALS_KEY,
    channelStatePath,
    FileChannelConfigStore,
    hasStoredCredentials,
} from "../../src/channels/channelConfigStore.ts";

let home: string;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "taco-channel-store-"));
});

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

describe("FileChannelConfigStore", () => {
    it("round-trips values through disk", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        await store.set("token", "t-123");

        const reopened = new FileChannelConfigStore("wechat", {}, home);
        assert.equal(reopened.get<string>("token"), "t-123");
    });

    it("writes the state file with 0o600", async () => {
        // POSIX mode bits are a no-op on Windows (see fsPermissions.ts),
        // so the assertion is meaningless there. The production code
        // emits a one-shot warning to make this discoverable, but the
        // ACL a per-user %LOCALAPPDATA% install gives the file is
        // enough to keep sibling accounts off it.
        if (process.platform === "win32") return;

        const store = new FileChannelConfigStore("wechat", {}, home);
        await store.set("token", "t-123");

        const mode = fs.statSync(channelStatePath("wechat", home)).mode & 0o777;
        assert.equal(mode, 0o600);
    });

    it("seeds from the taco.json config block", () => {
        const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
        assert.equal(store.get<string>("appId"), "a1");
    });

    it("persisted state wins over the seed on key collision", async () => {
        const first = new FileChannelConfigStore("wechat", { token: "from-config" }, home);
        await first.set("token", "from-runtime");

        const reopened = new FileChannelConfigStore("wechat", { token: "from-config" }, home);
        assert.equal(reopened.get<string>("token"), "from-runtime");
    });

    it("concurrent writes do not lose values", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3)]);

        const reopened = new FileChannelConfigStore("wechat", {}, home);
        assert.equal(reopened.get<number>("a"), 1);
        assert.equal(reopened.get<number>("b"), 2);
        assert.equal(reopened.get<number>("c"), 3);
    });

    it("namespaces state per channelId", async () => {
        await new FileChannelConfigStore("wechat", {}, home).set("token", "wx");
        await new FileChannelConfigStore("feishu", {}, home).set("token", "fs");

        assert.equal(new FileChannelConfigStore("wechat", {}, home).get<string>("token"), "wx");
        assert.equal(new FileChannelConfigStore("feishu", {}, home).get<string>("token"), "fs");
    });

    it("clear removes persisted state and falls back to the seed", async () => {
        const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
        await store.set("token", "t-123");
        await store.clear();

        assert.equal(store.get<string>("token"), undefined);
        assert.equal(store.get<string>("appId"), "a1");
        assert.equal(fs.existsSync(channelStatePath("wechat", home)), false);
    });

    it("treats a corrupt state file as empty rather than throwing", () => {
        const file = channelStatePath("wechat", home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{ not json");

        const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
        assert.equal(store.get<string>("token"), undefined);
        assert.equal(store.get<string>("appId"), "a1");
    });

    it("rejects an invalid channelId", () => {
        assert.throws(() => new FileChannelConfigStore("Bad/ID", {}, home), /invalid channelId/);
    });
});

describe("hasStoredCredentials", () => {
    it("is false when the channel has no state file", () => {
        assert.equal(hasStoredCredentials("wechat", home), false);
    });

    it("is false when the state file exists without a credentials key", async () => {
        // A seed-only config block (no bind yet) must not read as configured.
        await new FileChannelConfigStore("wechat", {}, home).set("cursor", "c-1");
        assert.equal(hasStoredCredentials("wechat", home), false);
    });

    it("is true once credentials are stored", async () => {
        await new FileChannelConfigStore("wechat", {}, home).set(CREDENTIALS_KEY, { uin: "u1" });
        assert.equal(hasStoredCredentials("wechat", home), true);
    });

    it("stays true regardless of connectivity — the contract is disk state", async () => {
        // This is the whole point of probing disk instead of deriving from the
        // bind state: an errored/expired binding still has credentials, so the
        // UI must offer Rebind rather than Bind.
        await new FileChannelConfigStore("wechat", {}, home).set(CREDENTIALS_KEY, { uin: "u1" });
        assert.equal(hasStoredCredentials("wechat", home), true);
    });

    it("is false after clear (unbind)", async () => {
        const store = new FileChannelConfigStore("wechat", {}, home);
        await store.set(CREDENTIALS_KEY, { uin: "u1" });
        await store.clear();
        assert.equal(hasStoredCredentials("wechat", home), false);
    });

    it("is false for a corrupt state file", () => {
        const file = channelStatePath("wechat", home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{ not json");
        assert.equal(hasStoredCredentials("wechat", home), false);
    });
});
