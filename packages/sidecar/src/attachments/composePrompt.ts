/**
 * Turn staged attachment ids into what a prompt carries.
 *
 * One call per outgoing message: it commits the staged files into the
 * session, appends the `attachments` tag to the prompt text, and, when the
 * model can see images, inlines the image attachments as image blocks too.
 * Inlining is additive. The file is on disk and named in the tag either way,
 * so a tool or skill can still work on the original.
 */

import { readFile } from "node:fs/promises";
import { ATTACHMENT_MAX_COUNT, type ImageInput } from "@taco-ai/protocol";

import { AttachmentError, commitAttachments } from "./attachmentStore.ts";
import { buildAttachmentsTag } from "./attachmentsTag.ts";

export interface ComposedPrompt {
    text: string;
    images: ImageInput[] | undefined;
}

export interface ComposeOptions {
    ids: readonly string[] | undefined;
    text: string;
    images: ImageInput[] | undefined;
    /** Namespaces staging, so only the workspace that staged an id can commit it. */
    workspaceId: string;
    sessionsRoot: string;
    sessionId: string;
    /** Whether the session's current model accepts image input. */
    modelSeesImages: boolean;
}

/**
 * Returns the prompt unchanged when there are no ids, so every caller can use
 * it unconditionally.
 *
 * An empty `text` stays empty-plus-tag: a message that is only attachments is
 * valid, and the tag is then the whole text block.
 */
export async function composePrompt(opts: ComposeOptions): Promise<ComposedPrompt> {
    const { ids, text, images } = opts;
    if (!ids || ids.length === 0) return { text, images };
    if (ids.length > ATTACHMENT_MAX_COUNT) {
        throw new AttachmentError(
            "too_many",
            `a message carries at most ${ATTACHMENT_MAX_COUNT} attachments`,
        );
    }

    const committed = await commitAttachments(
        ids,
        opts.workspaceId,
        opts.sessionsRoot,
        opts.sessionId,
    );

    const inline: ImageInput[] = [];
    const described = committed.map((a) => ({ ...a }));
    if (opts.modelSeesImages) {
        for (const a of described) {
            if (a.kind !== "image") continue;
            const bytes = await readFile(a.path);
            inline.push({ type: "image", data: bytes.toString("base64"), mimeType: a.mimeType });
            // Recorded in the tag so a view can tell the inlined copy from an
            // image the client sent itself, rather than guessing from counts.
            a.inlined = true;
        }
    }

    const tag = buildAttachmentsTag(described);
    const withTag = text === "" ? tag : `${text}\n\n${tag}`;
    const merged = [...(images ?? []), ...inline];
    return { text: withTag, images: merged.length > 0 ? merged : undefined };
}

/** What a composer needs from an attached session. */
interface ModelCapabilities {
    modelSeesImages(): Promise<boolean>;
}

/** The slice of a workspace that locates staging and committed files. */
interface SessionsRootOwner {
    readonly workspaceKey: string;
    readonly sessionsRoot: string;
}

/**
 * `composePrompt` for a handler that holds the workspace and attached session:
 * supplies the sessions root and asks the session whether its model sees
 * images. Returns the inputs untouched without ids, and skips the model lookup
 * entirely in that case.
 */
export async function composeForSession(
    workspace: SessionsRootOwner,
    attached: ModelCapabilities,
    sessionId: string,
    text: string,
    images: ImageInput[] | undefined,
    ids: readonly string[] | undefined,
): Promise<ComposedPrompt> {
    if (!ids || ids.length === 0) return { text, images };
    return composePrompt({
        ids,
        text,
        images,
        workspaceId: workspace.workspaceKey,
        sessionsRoot: workspace.sessionsRoot,
        sessionId,
        modelSeesImages: await attached.modelSeesImages(),
    });
}
