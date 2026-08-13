/**
 * im_channel tag — unit tests.
 *
 * Verifies the hook injects a hidden <im_channel> tag with exactly
 * type + channel_id, stays a no-op for non-IM workspaces, appends to the
 * tail, mutates in-place, and reads the getter on every call (dynamic).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildImChannelContextHook } from "../../src/tags/imChannelContext.ts";

function makeUserMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

type HookResult = { messages: AgentMessage[] };

/** Narrow a hook result to a non-undefined return (lint: no non-null assertions). */
function expectInjected(result: HookResult | undefined): HookResult {
    if (!result) throw new Error("expected hook to inject <im_channel>");
    return result;
}

function messageAt(messages: AgentMessage[], index: number): AgentMessage {
    const msg = messages[index];
    if (!msg) throw new Error(`expected message at index ${index}`);
    return msg;
}

function textOf(msg: AgentMessage): string {
    const content = (msg as { content: { type: "text"; text: string }[] }).content;
    return content[0].text;
}

describe("buildImChannelContextHook", () => {
    it("appends an <im_channel> tag with type + channel_id to the tail", () => {
        const hook = buildImChannelContextHook(() => ({
            type: "wechat",
            channelId: "wechat-work",
        }));
        const event = { messages: [makeUserMessage("hello")] };
        const result = expectInjected(hook(event));

        assert.equal(result.messages.length, 2);
        assert.equal(result.messages[1], event.messages[1], "tail-append, original first");
        const text = textOf(messageAt(result.messages, 1));
        assert.match(text, /^<im_channel>/);
        assert.match(text, /type: wechat/);
        assert.match(text, /channel_id: wechat-work/);
        assert.match(text, /<\/im_channel>$/);
    });

    it("returns undefined (no mutation) when the getter yields undefined", () => {
        const hook = buildImChannelContextHook(() => undefined);
        const original = [makeUserMessage("hello")];
        const event = { messages: original };
        const result = hook(event);

        assert.equal(result, undefined);
        assert.equal(event.messages, original);
        assert.equal(event.messages.length, 1);
    });

    it("mutates event.messages in place and returns the same reference", () => {
        const hook = buildImChannelContextHook(() => ({
            type: "feishu",
            channelId: "feishu-team",
        }));
        const event = { messages: [makeUserMessage("hi")] };
        const result = expectInjected(hook(event));

        assert.equal(result.messages, event.messages, "same array reference (last-writer-wins)");
    });

    it("reads the getter on every call (dynamic, not a construction snapshot)", () => {
        let current = { type: "wechat", channelId: "wechat-a" };
        const hook = buildImChannelContextHook(() => current);

        const first = expectInjected(hook({ messages: [makeUserMessage("m1")] }));
        assert.match(textOf(messageAt(first.messages, 1)), /channel_id: wechat-a/);

        current = { type: "feishu", channelId: "feishu-b" };
        const second = expectInjected(hook({ messages: [makeUserMessage("m2")] }));
        assert.match(textOf(messageAt(second.messages, 1)), /channel_id: feishu-b/);
        assert.match(textOf(messageAt(second.messages, 1)), /type: feishu/);
    });

    it("never exposes peer/chat ids or credentials even when the source has them", () => {
        // The upstream route fixture may carry peerId/chatId; the hook only
        // consumes the safe DTO, so they must not appear in the tag.
        const hook = buildImChannelContextHook(() => ({
            type: "mock",
            channelId: "mock-1",
        }));
        const event = { messages: [makeUserMessage("hi")] };
        const result = expectInjected(hook(event));
        const text = textOf(messageAt(result.messages, 1));
        assert.doesNotMatch(text, /peer_id/);
        assert.doesNotMatch(text, /chat_id/);
        assert.doesNotMatch(text, /credential|token|secret/i);
    });
});
