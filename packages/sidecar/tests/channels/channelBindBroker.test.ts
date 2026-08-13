import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelBindStatus } from "../../src/channels/channelBindBroker.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";

describe("ChannelBindBroker", () => {
    it("reports unbound for an unknown channel", () => {
        const broker = new ChannelBindBroker();
        assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
    });

    it("emits status on every transition", () => {
        const broker = new ChannelBindBroker();
        const seen: ChannelBindStatus[] = [];
        broker.on("status", (s: ChannelBindStatus) => seen.push(s));

        broker.requestScan("wechat", "https://qr.example/abc");
        broker.setState("wechat", "connected");

        assert.deepEqual(
            seen.map((s) => s.state),
            ["awaiting_scan", "connected"],
        );
        assert.equal(seen[0].qrUrl, "https://qr.example/abc");
    });

    it("resolves a pending verify-code request via submitVerifyCode", async () => {
        const broker = new ChannelBindBroker();
        let requestId: string | undefined;
        broker.on("status", (s: ChannelBindStatus) => {
            if (s.state === "awaiting_verify_code") requestId = s.requestId;
        });

        const pending = broker.requestVerifyCode("wechat", false);
        assert.ok(requestId);
        assert.equal(broker.submitVerifyCode(requestId, "123456"), true);
        assert.equal(await pending, "123456");
        assert.equal(broker.status("wechat").state, "connecting");
    });

    it("marks a retry request so the UI can say the code was wrong", () => {
        const broker = new ChannelBindBroker();
        const seen: ChannelBindStatus[] = [];
        broker.on("status", (s: ChannelBindStatus) => seen.push(s));

        void broker.requestVerifyCode("wechat", true).catch(() => {});
        assert.equal(seen[0].retry, true);
        broker.cancelAll();
    });

    it("submitVerifyCode returns false for an unknown requestId", () => {
        const broker = new ChannelBindBroker();
        assert.equal(broker.submitVerifyCode("no-such-id", "123456"), false);
    });

    it("rejects and marks expired when the verify code times out", async () => {
        const broker = new ChannelBindBroker(10);
        await assert.rejects(broker.requestVerifyCode("wechat", false), /timed out/);
        assert.equal(broker.status("wechat").state, "expired");
    });

    it("cancel rejects pending requests for that channel only", async () => {
        const broker = new ChannelBindBroker();
        const wechat = broker.requestVerifyCode("wechat", false);
        const feishu = broker.requestVerifyCode("feishu", false);

        broker.cancel("wechat");

        await assert.rejects(wechat, /binding cancelled/);
        broker.cancel("feishu");
        await assert.rejects(feishu, /binding cancelled/);
    });

    it("cancelAll rejects every pending request", async () => {
        const broker = new ChannelBindBroker();
        const a = broker.requestVerifyCode("wechat", false);
        const b = broker.requestVerifyCode("feishu", false);

        broker.cancelAll();

        await assert.rejects(a, /shutting down/);
        await assert.rejects(b, /shutting down/);
    });

    it("reset cancels pending and re-publishes unbound state", async () => {
        const broker = new ChannelBindBroker();
        broker.setState("wechat", "connected");
        const pending = broker.requestVerifyCode("wechat", false);

        broker.reset("wechat");

        await assert.rejects(pending, /binding cancelled/);
        assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
    });

    it("listStatuses reports every known channel", () => {
        const broker = new ChannelBindBroker();
        broker.setState("wechat", "connected");
        broker.setState("feishu", "unbound");

        assert.deepEqual(
            broker
                .listStatuses()
                .map((s) => s.channelId)
                .sort(),
            ["feishu", "wechat"],
        );
    });

    it("a second requestVerifyCode supersedes the prior pending entry", async () => {
        // The SDK re-fires onVerifyCode(isRetry=true) after the user enters a
        // wrong code. Without cancellation the prior timer would fire
        // verifyTimeoutMs later and setState("expired") over the fresh
        // awaiting_verify_code state.
        const broker = new ChannelBindBroker();
        const first = broker.requestVerifyCode("wechat", false);
        const second = broker.requestVerifyCode("wechat", true);

        await assert.rejects(first, /superseded/);
        assert.equal(broker.status("wechat").state, "awaiting_verify_code");
        // Exactly one pending entry remains — the second.
        assert.equal((broker as unknown as { pending: Map<string, unknown> }).pending.size, 1);

        // Resolve the second via the public submitVerifyCode path so its
        // promise settles and node --test doesn't hang on the dangling await.
        const { requestId } = broker.status("wechat");
        assert.ok(requestId, "broker should hold the awaiting_verify_code requestId");
        broker.submitVerifyCode(requestId, "123456");
        await assert.doesNotReject(second);
    });
});
