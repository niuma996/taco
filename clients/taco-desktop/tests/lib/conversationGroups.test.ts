import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { makeImCwd } from "@taco-ai/protocol";
import {
    buildChannelConversationItems,
    buildWorkspaceGroups,
} from "../../src/lib/chat/conversationGroups";

describe("conversation navigation models", () => {
    it("preserves the persisted workspace order independently of session activity", () => {
        const groups = buildWorkspaceGroups({
            "/repo/two": {
                cwd: "/repo/two",
                sessions: [
                    {
                        id: "two-1",
                        createdAt: "2026-03-01",
                        updatedAt: "2026-01-01",
                    },
                ],
                pendingBySessionId: {},
            },
            "/repo/one": {
                cwd: "/repo/one",
                sessions: [
                    {
                        id: "one-1",
                        createdAt: "2026-01-01",
                        updatedAt: "2026-02-01",
                    },
                ],
                pendingBySessionId: {},
            },
        } as never);

        assert.deepEqual(
            groups.map((group) => group.key),
            ["workspace:/repo/two", "workspace:/repo/one"],
        );
        assert.equal(groups[1].kind, "workspace");
        assert.equal(groups[1].label, "one");
        assert.deepEqual(
            groups[1].items.map((item) => item.sessionId),
            ["one-1"],
        );
    });

    it("flattens IM conversations across channels and peer directories", () => {
        const items = buildChannelConversationItems(
            [
                {
                    channelId: "wecom",
                    peerId: "alice",
                    chatId: "chat-2",
                    sessionId: "im-2",
                    lastUsedAt: 2,
                },
                {
                    channelId: "wecom",
                    peerId: "alice",
                    chatId: "chat-4",
                    sessionId: "im-4",
                    lastUsedAt: 0.5,
                },
                {
                    channelId: "feishu",
                    peerId: "bob",
                    chatId: "chat-1",
                    sessionId: "im-1",
                    lastUsedAt: 1,
                },
                {
                    channelId: "wecom",
                    peerId: "carol",
                    chatId: "chat-3",
                    sessionId: "im-3",
                    lastUsedAt: 3,
                    name: "Renamed chat",
                    updatedAt: "2026-03-01T00:00:00Z",
                },
            ],
            {},
        );

        assert.deepEqual(
            items.map((item) => item.sessionId),
            ["im-3", "im-2", "im-1", "im-4"],
        );
        assert.equal(items[0]?.cwd, makeImCwd("wecom", "carol", "chat-3"));
        assert.equal(items[0]?.label, "Renamed chat");
        assert.equal(items[0]?.updatedAt, "2026-03-01T00:00:00Z");
        assert.equal(items[1]?.label, "chat-2");
        assert.equal(items[1]?.channelId, "wecom");
        assert.equal(items[2]?.channelId, "feishu");
    });
});
