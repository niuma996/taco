/**
 * Attachment staging + message-model plumbing.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ATTACHMENT_STAGE_INLINE_MAX_BYTES, type AttachmentStageResult } from "@taco-ai/protocol";

import {
    ATTACHMENT_MAX_COUNT,
    formatBytes,
    nameForPastedFile,
    type StageFn,
    stageSources,
    toMessageAttachments,
} from "../../src/lib/attachments";
import { applyEventToMessages } from "../../src/lib/chat/applyEventToMessages";
import {
    extractAttachments,
    historyToUiMessages,
    type SessionEventLike,
    type UiMessage,
} from "../../src/lib/chat/chatUtils";
import { buildUserMessageGuide } from "../../src/lib/chat/userMessageGuide";

const NOW = 1_700_000_000_000;
const opts = { suppressedThinking: false, now: NOW };

let seq = 0;
const okStage: StageFn = async (source) => {
    seq++;
    const name = "path" in source ? (source.path.split("/").pop() ?? "f") : source.name;
    return {
        id: `id-${seq}`,
        name,
        mimeType: name.endsWith(".png") ? "image/png" : "application/pdf",
        size: 100,
        kind: name.endsWith(".png") ? "image" : "file",
    } satisfies AttachmentStageResult;
};

describe("stageSources", () => {
    it("stages every source and keeps order", async () => {
        const out = await stageSources(
            [{ source: { path: "/a/one.pdf" } }, { source: { path: "/a/two.pdf" } }],
            0,
            okStage,
        );
        assert.deepEqual(
            out.staged.map((s) => s.name),
            ["one.pdf", "two.pdf"],
        );
        assert.deepEqual(out.rejected, []);
    });

    it("stops at the per-message cap counting what is already attached", async () => {
        const sources = Array.from({ length: 4 }, (_, i) => ({ source: { path: `/a/f${i}.pdf` } }));
        const out = await stageSources(sources, ATTACHMENT_MAX_COUNT - 2, okStage);
        assert.equal(out.staged.length, 2);
        assert.deepEqual(out.rejected, ["too_many", "too_many"]);
    });

    it("refuses an oversized paste before reading or staging it", async () => {
        let called = false;
        const blob = new Blob([new Uint8Array(ATTACHMENT_STAGE_INLINE_MAX_BYTES + 1)]);
        const out = await stageSources([{ source: { name: "big", blob } }], 0, async (s) => {
            called = true;
            return okStage(s);
        });
        assert.equal(called, false);
        assert.deepEqual(out.rejected, ["too_large"]);
    });

    it("sends pasted bytes as base64 only after the size check", async () => {
        let seen: unknown;
        await stageSources(
            [{ source: { name: "a.txt", blob: new Blob(["hi"]), mimeType: "text/plain" } }],
            0,
            async (s) => {
                seen = s;
                return okStage(s);
            },
        );
        assert.deepEqual(seen, {
            name: "a.txt",
            mimeType: "text/plain",
            data: Buffer.from("hi").toString("base64"),
        });
    });

    it("allows a path source that is larger than the inline paste limit", async () => {
        const out = await stageSources(
            [{ source: { path: "/a/big.pdf" }, size: 20 * 1024 * 1024 }],
            0,
            okStage,
        );
        assert.equal(out.staged.length, 1);
    });

    it("one failure does not cost the others, and reads the refusal reason", async () => {
        const flaky: StageFn = async (source) => {
            if ("path" in source && source.path.endsWith("bad.pdf")) {
                throw Object.assign(new Error("nope"), {
                    code: "invalid_params",
                    data: { reason: "too_large" },
                });
            }
            if ("path" in source && source.path.endsWith("odd.pdf")) {
                throw Object.assign(new Error("nope"), { code: "invalid_params" });
            }
            if ("path" in source && source.path.endsWith("boom.pdf")) throw new Error("disk");
            return okStage(source);
        };
        const out = await stageSources(
            [
                { source: { path: "/a/bad.pdf" } },
                { source: { path: "/a/odd.pdf" } },
                { source: { path: "/a/boom.pdf" } },
                { source: { path: "/a/good.pdf" } },
            ],
            0,
            flaky,
        );
        assert.deepEqual(
            out.staged.map((s) => s.name),
            ["good.pdf"],
        );
        assert.deepEqual(out.rejected, ["too_large", "failed", "failed"]);
    });

    it("keeps a preview only for what the sidecar confirmed as an image", async () => {
        const out = await stageSources(
            [
                { source: { path: "/a/real.png" }, previewUrl: "asset://real" },
                { source: { path: "/a/fake.pdf" }, previewUrl: "asset://fake" },
            ],
            0,
            okStage,
        );
        assert.equal(out.staged[0]?.previewUrl, "asset://real");
        assert.equal(out.staged[1]?.previewUrl, undefined);
    });
});

describe("helpers", () => {
    it("names pasted files that arrive without a name", () => {
        assert.equal(nameForPastedFile(new File([], "")), "pasted");
        assert.equal(nameForPastedFile(new File([], "", { type: "image/png" })), "pasted.png");
        assert.equal(nameForPastedFile(new File([], "", { type: "image/svg+xml" })), "pasted.svg");
        assert.equal(nameForPastedFile(new File([], "a.txt")), "a.txt");
    });

    it("formats sizes", () => {
        assert.equal(formatBytes(500), "500 B");
        assert.equal(formatBytes(2048), "2 KB");
        assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
    });

    it("builds optimistic chips with an empty path", () => {
        const [a] = toMessageAttachments([
            { id: "i", name: "a.pdf", mimeType: "application/pdf", size: 1, kind: "file" },
        ]);
        assert.deepEqual(a, {
            name: "a.pdf",
            mimeType: "application/pdf",
            size: 1,
            kind: "file",
            path: "",
        });
    });
});

describe("extractAttachments", () => {
    it("reads well-formed entries and skips malformed ones", () => {
        const out = extractAttachments({
            attachments: [
                {
                    name: "a.pdf",
                    mimeType: "application/pdf",
                    size: 5,
                    path: "/p/a.pdf",
                    kind: "file",
                },
                { name: 1 },
                null,
                { name: "b.png", mimeType: "image/png", kind: "image" },
            ],
        });
        assert.equal(out.length, 2);
        assert.equal(out[1]?.size, 0);
        assert.equal(out[1]?.kind, "image");
    });

    it("is empty when the field is absent or not an array", () => {
        assert.deepEqual(extractAttachments({}), []);
        assert.deepEqual(extractAttachments({ attachments: "x" }), []);
        assert.deepEqual(extractAttachments(undefined), []);
    });
});

describe("history + live echo", () => {
    const file = {
        name: "a.pdf",
        mimeType: "application/pdf",
        size: 5,
        path: "/s/1-a.pdf",
        kind: "file" as const,
    };

    it("history carries attachments onto the user message", () => {
        const msgs = historyToUiMessages([
            {
                id: "e1",
                type: "message",
                payload: {
                    role: "user",
                    content: [{ type: "text", text: "see this" }],
                    attachments: [file],
                },
                timestamp: "2026-01-01T00:00:00Z",
            },
        ] as never);
        const m = msgs[0];
        assert.equal(m?.kind, "user");
        assert.deepEqual(m?.kind === "user" ? m.attachments : undefined, [file]);
    });

    function echo(over: object) {
        return {
            type: "message_end",
            message: {
                role: "user",
                timestamp: 7,
                content: [{ type: "text", text: "see this" }],
                ...over,
            },
        } as unknown as SessionEventLike;
    }

    it("the server echo replaces the optimistic bubble and brings the committed path", () => {
        const before: UiMessage[] = [
            {
                id: "optimistic-user-1",
                kind: "user",
                text: "see this",
                ts: 1,
                attachments: [{ ...file, path: "" }],
            },
        ];
        const { messages } = applyEventToMessages(before, echo({ attachments: [file] }), opts);
        assert.equal(messages.length, 1);
        const m = messages[0];
        assert.equal(m?.kind === "user" ? m.id : "", "live-user-7");
        assert.equal(m?.kind === "user" ? m.attachments?.[0]?.path : "", "/s/1-a.pdf");
    });

    it("does not merge two sends with the same text but different files", () => {
        const before: UiMessage[] = [
            {
                id: "optimistic-user-1",
                kind: "user",
                text: "see this",
                ts: 1,
                attachments: [{ ...file, name: "other.pdf", path: "" }],
            },
        ];
        const { messages } = applyEventToMessages(before, echo({ attachments: [file] }), opts);
        assert.equal(messages.length, 2, "the echo appends instead of stealing the other bubble");
    });

    it("an attachments-only message keeps its bubble", () => {
        const { messages } = applyEventToMessages(
            [],
            echo({ content: [], attachments: [file] }),
            opts,
        );
        const m = messages[0];
        assert.equal(m?.kind === "user" ? m.attachments?.length : 0, 1);
    });
});

describe("user message guide", () => {
    it("carries attachments into the entry", () => {
        const messages: UiMessage[] = [
            {
                id: "u1",
                kind: "user",
                text: "",
                ts: 1,
                attachments: [
                    { name: "a.pdf", mimeType: "application/pdf", size: 1, path: "", kind: "file" },
                ],
            },
            { id: "u2", kind: "user", text: "plain", ts: 2 },
        ];
        const entries = buildUserMessageGuide(messages);
        assert.equal(entries[0]?.attachments.length, 1);
        assert.deepEqual(entries[1]?.attachments, []);
    });
});
