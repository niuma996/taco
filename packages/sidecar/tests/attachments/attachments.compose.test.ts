import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { MessageAttachment } from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";

import { stageFromData } from "../../src/attachments/attachmentStore.ts";
import { buildAttachmentsTag, parseAttachmentsTags } from "../../src/attachments/attachmentsTag.ts";
import { composeForSession, composePrompt } from "../../src/attachments/composePrompt.ts";
import { viewUserContent } from "../../src/attachments/userMessageView.ts";
import {
    textFromAgentMessage,
    textsFromAgentMessages,
} from "../../src/runtime/harness/messageText.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";
import { tagRegistry } from "../../src/tags/index.ts";
import { callMethod } from "../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("attachments-compose");

const WS = "/w";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

const sample: MessageAttachment[] = [
    { path: "/s/1-a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 10, kind: "file" },
    { path: "/s/2-b.png", name: "b.png", mimeType: "image/png", size: 20, kind: "image" },
];

describe("attachments tag", () => {
    it("is registered hidden + summarize", () => {
        const spec = tagRegistry.attachments;
        assert.equal(spec.tuiVisibility, "hidden");
        assert.equal(spec.compression.kind, "summarize");
        assert.equal(spec.scope, "user-request");
    });

    it("round-trips through build and parse", () => {
        assert.deepEqual(parseAttachmentsTags(buildAttachmentsTag(sample)), sample);
    });

    it("escapes quotes, angle brackets and ampersands in names and paths", () => {
        const nasty: MessageAttachment = {
            path: '/s/3-"x" <&>.txt',
            name: '"x" <&>.txt',
            mimeType: "text/plain",
            size: 1,
            kind: "file",
        };
        const tag = buildAttachmentsTag([nasty]);
        assert.ok(!tag.includes('"x" <&>'), "raw characters must not appear inside attributes");
        assert.deepEqual(parseAttachmentsTags(tag), [nasty]);
    });

    it("is empty for no attachments", () => {
        assert.equal(buildAttachmentsTag([]), "");
        assert.deepEqual(parseAttachmentsTags("plain text"), []);
    });

    it("does not read a tag the user quoted inside a code fence", () => {
        const fenced = `look:\n\`\`\`\n${buildAttachmentsTag(sample)}\n\`\`\``;
        assert.deepEqual(parseAttachmentsTags(fenced), []);
    });

    it("skips an element without a path or name", () => {
        const broken = '<attachments>\n<file name="only-name"/>\n</attachments>';
        assert.deepEqual(parseAttachmentsTags(broken), []);
    });
});

/** `viewUserContent` returns blocks for block input; narrow for the assertions. */
function blocks(view: ReturnType<typeof viewUserContent>) {
    assert.ok(Array.isArray(view.content), "expected block content");
    return view.content as Array<{ type: string }>;
}

describe("viewUserContent", () => {
    it("returns the typed text exactly, so an optimistic bubble still matches the echo", () => {
        const typed = "please summarise these";
        const stored = `${typed}\n\n${buildAttachmentsTag(sample)}`;
        const view = viewUserContent([{ type: "text", text: stored }]);
        assert.deepEqual(view.content, [{ type: "text", text: typed }]);
        assert.deepEqual(view.attachments, sample);
        assert.equal(view.empty, false);
    });

    it("handles string content too", () => {
        const view = viewUserContent(`hi\n\n${buildAttachmentsTag(sample)}`);
        assert.equal(view.content, "hi");
        assert.equal(view.attachments.length, 2);
    });

    it("keeps an attachment-only message instead of hiding it as empty", () => {
        const view = viewUserContent([{ type: "text", text: buildAttachmentsTag(sample) }]);
        assert.equal(view.empty, false);
        assert.equal(view.attachments.length, 2);
    });

    it("still hides a message that has no visible content and no attachments", () => {
        const view = viewUserContent([{ type: "text", text: "<env>x</env>" }]);
        assert.equal(view.empty, true);
        assert.deepEqual(view.attachments, []);
    });

    it("leaves a message without attachments exactly as visibility shapes it", () => {
        const view = viewUserContent([{ type: "text", text: "hello  " }]);
        assert.deepEqual(view.content, [{ type: "text", text: "hello  " }]);
    });

    it("drops the inlined copy of an image attachment so it renders once", () => {
        const inlinedSample = sample.map((x) => (x.kind === "image" ? { ...x, inlined: true } : x));
        const img = { type: "image" as const, data: "AA", mimeType: "image/png" };
        const stored = [
            { type: "text" as const, text: `look\n\n${buildAttachmentsTag(inlinedSample)}` },
            img,
        ];
        const view = viewUserContent(stored);
        assert.deepEqual(view.content, [{ type: "text", text: "look" }]);
        assert.deepEqual(view.attachments, inlinedSample);
    });

    it("keeps a client-sent image when the attachment was not inlined (text-only model)", () => {
        const sent = { type: "image" as const, data: "ZZ", mimeType: "image/jpeg" };
        // `sample` has an image attachment but no inlined flag: the model never got a copy.
        const stored = [
            { type: "text" as const, text: `x\n\n${buildAttachmentsTag(sample)}` },
            sent,
        ];
        const view = viewUserContent(stored);
        assert.deepEqual(view.content[1], sent);
    });

    it("drops only the trailing inlined copy and keeps the client-sent image before it", () => {
        const sent = { type: "image" as const, data: "ZZ", mimeType: "image/jpeg" };
        const copy = { type: "image" as const, data: "AA", mimeType: "image/png" };
        const inlinedSample = sample.map((x) => (x.kind === "image" ? { ...x, inlined: true } : x));
        const stored = [
            { type: "text" as const, text: `x\n\n${buildAttachmentsTag(inlinedSample)}` },
            sent,
            copy,
        ];
        const view = viewUserContent(stored);
        assert.equal(blocks(view).filter((b) => b.type === "image").length, 1);
        assert.deepEqual(view.content[1], sent);
    });

    it("keeps inline image blocks", () => {
        const img = { type: "image" as const, data: "AA", mimeType: "image/png" };
        const view = viewUserContent([{ type: "text", text: "see" }, img]);
        assert.equal(view.empty, false);
        assert.deepEqual(view.content[1], img);
    });
});

describe("abort restore text", () => {
    const msg = (text: string): AgentMessage =>
        ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;

    it("does not hand the attachments tag back to the composer", () => {
        const stored = `redirect please\n\n${buildAttachmentsTag(sample)}`;
        assert.equal(textFromAgentMessage(msg(stored)), "redirect please");
    });

    it("drops an attachments-only steer, like an image-only one", () => {
        assert.deepEqual(textsFromAgentMessages([msg(buildAttachmentsTag(sample))]), []);
    });
});

describe("composePrompt", () => {
    let root: string;
    before(async () => {
        root = await mkdtemp(join(tmpdir(), "taco-compose-"));
    });
    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const base = (over: Partial<Parameters<typeof composePrompt>[0]>) => ({
        ids: undefined,
        text: "hello",
        images: undefined,
        workspaceId: WS,
        sessionsRoot: root,
        sessionId: "s1",
        modelSeesImages: true,
        ...over,
    });

    it("returns the prompt untouched without ids", async () => {
        const images = [{ type: "image" as const, data: "AA", mimeType: "image/png" }];
        const out = await composePrompt(base({ images }));
        assert.equal(out.text, "hello");
        assert.equal(out.images, images);
    });

    it("appends the tag after the text and inlines images for a vision model", async () => {
        const pdf = await stageFromData(WS, "a.pdf", b64("%PDF"), undefined);
        const png = await stageFromData(WS, "b.png", b64(PNG), undefined);
        const out = await composePrompt(base({ ids: [pdf.id, png.id], sessionId: "s-vision" }));

        const parsed = parseAttachmentsTags(out.text);
        assert.equal(parsed.length, 2);
        assert.ok(out.text.startsWith("hello\n\n<attachments>"));
        assert.equal(out.images?.length, 1);
        assert.equal(parsed.find((x) => x.kind === "image")?.inlined, true);
        assert.equal(parsed.find((x) => x.kind === "file")?.inlined, undefined);
        assert.equal(out.images?.[0]?.mimeType, "image/png");
        assert.equal(out.images?.[0]?.data, b64(PNG));
    });

    it("does not inline images for a text-only model, but still names them", async () => {
        const png = await stageFromData(WS, "c.png", b64(PNG), undefined);
        const out = await composePrompt(
            base({ ids: [png.id], sessionId: "s-text", modelSeesImages: false }),
        );
        assert.equal(out.images, undefined);
        assert.equal(parseAttachmentsTags(out.text)[0]?.kind, "image");
        assert.equal(parseAttachmentsTags(out.text)[0]?.inlined, undefined);
    });

    it("keeps images the client already sent and adds the inlined ones", async () => {
        const png = await stageFromData(WS, "d.png", b64(PNG), undefined);
        const existing = [{ type: "image" as const, data: "ZZ", mimeType: "image/jpeg" }];
        const out = await composePrompt(
            base({ ids: [png.id], sessionId: "s-merge", images: existing }),
        );
        assert.equal(out.images?.length, 2);
        assert.equal(out.images?.[0]?.data, "ZZ");
    });

    it("makes the tag the whole text for an attachments-only message", async () => {
        const f = await stageFromData(WS, "e.txt", b64("x"), undefined);
        const out = await composePrompt(base({ ids: [f.id], text: "", sessionId: "s-only" }));
        assert.ok(out.text.startsWith("<attachments>"));
    });

    it("rejects more than the per-message cap", async () => {
        const ids = Array.from({ length: 9 }, (_, i) => `id-${i}`);
        await assert.rejects(composePrompt(base({ ids })), /at most 8/);
    });

    it("composeForSession skips the model lookup when there are no ids", async () => {
        let asked = false;
        const attached = {
            modelSeesImages: async () => {
                asked = true;
                return true;
            },
        };
        const out = await composeForSession(
            { workspaceKey: WS, sessionsRoot: root },
            attached,
            "s",
            "hi",
            undefined,
            undefined,
        );
        assert.equal(out.text, "hi");
        assert.equal(asked, false);
    });
});

describe("attachment.stage handler", () => {
    before(() => {
        registerBuiltinMethods();
    });

    it("stages inline data over the registered schema", async () => {
        const r = await callMethod<{ id: string; kind: string }>("attachment.stage", {
            params: { workspace: "/w", name: "n.txt", data: b64("hi") },
            cwd: WS,
        });
        assert.equal(r.kind, "file");
        assert.match(r.id, /^[0-9a-f-]{36}$/);
    });

    it("rejects a call that carries both a path and a body at the schema gate", async () => {
        await assert.rejects(
            callMethod("attachment.stage", {
                params: { workspace: "/w", path: "/x", name: "n", data: "AA" },
            }),
            (e: unknown) => (e as { code?: string }).code === ErrorCodes.InvalidParams,
        );
    });

    it("rejects a call that carries neither", async () => {
        await assert.rejects(
            callMethod("attachment.stage", { params: { workspace: "/w" } }),
            (e: unknown) => (e as { code?: string }).code === ErrorCodes.InvalidParams,
        );
    });

    it("maps a missing file to not_found", async () => {
        await assert.rejects(
            callMethod("attachment.stage", {
                params: { workspace: "/w", path: "/definitely/not/here.bin" },
                cwd: WS,
            }),
            (e: unknown) => (e as { code?: string }).code === ErrorCodes.NotFound,
        );
    });

    it("carries why it refused, so a client does not read every invalid_params as too large", async () => {
        const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
        await assert.rejects(
            callMethod("attachment.stage", {
                params: { workspace: "/w", name: "b", data: big },
                cwd: WS,
            }),
            (e: unknown) => {
                const fault = e as { code?: string; data?: { reason?: string } };
                return (
                    fault.code === ErrorCodes.InvalidParams && fault.data?.reason === "too_large"
                );
            },
        );
        await assert.rejects(
            callMethod("attachment.stage", {
                params: { workspace: "/w", path: "/definitely/not/here.bin" },
                cwd: WS,
            }),
            (e: unknown) => {
                const fault = e as { data?: { reason?: string } };
                return fault.data?.reason === "not_found";
            },
        );
    });
});
