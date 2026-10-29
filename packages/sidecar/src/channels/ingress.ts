import { extname } from "node:path";
import type { PromptParams, SteerResult } from "@taco-ai/protocol";
import {
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MAX_COUNT,
    asSessionId,
    asWorkspaceId,
    createRpcRequest,
    ErrorCodes,
    RPC,
} from "@taco-ai/protocol";
import { stageFromData } from "../attachments/attachmentStore.ts";
import { extensionForMime, isModelImageMime, sniffImageMime } from "../attachments/mimeType.ts";
import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";
import type { ConversationRouter } from "./conversationRouter.ts";
import type {
    ChannelConfigStore,
    ChannelContext,
    ChannelIngress,
    ChannelMediaRef,
    Logger,
} from "./types.ts";

/** DefaultChannelContext holds no concrete SidecarServer reference (avoids channels
 *  layer reverse-depending on server layer), instead injecting the narrow ServerRpcSurface
 *  interface and ConversationRouter. */
export class DefaultChannelContext implements ChannelContext {
    constructor(
        readonly channelId: string,
        private readonly hook: ServerRpcSurface,
        private readonly router: ConversationRouter,
        private readonly store: ChannelConfigStore,
        readonly logger: Logger,
    ) {}

    get config(): ChannelConfigStore {
        return this.store;
    }

    get ingress(): ChannelIngress {
        return {
            submit: async (msg) => {
                // route() derives the sessionId from the (channelId, peerId, chatId)
                // triple and returns it. Reusing the same triple across messages
                // routes to the same session; the router persists the choice in
                // routing.json so the peer+chat conversation has a stable UUID
                // across restarts. Passing a caller-supplied sessionId here would
                // race with that derivation and leak per-message ids into
                // routing.json, so we deliberately do not.
                const { workspace, sessionId } = await this.router.route(
                    this.hook,
                    msg.channelId,
                    msg.peerId,
                    msg.chatId,
                );

                // route() already created the empty session; here we separately deliver
                // the real text prompt — two steps rather than session.create with an
                // initialPrompt — so that route() can return a stable sessionId first
                // and then this dispatches the actual message. platformMessageId is
                // used as the RPC id for idempotency.
                // platformMessageId doubles as both RPC id and commandId:
                // id is used for frame-level response / tracing, commandId for sidecar command idempotency dedup.
                const id = msg.platformMessageId;
                const staged = await stageMedia(msg.media, workspace);
                // A refusal is otherwise invisible: the prompt names only the
                // attachments that arrived, and the sender is never told a
                // file was lost. The note in the prompt and this log say so.
                if (staged.refused > 0) {
                    this.logger.warn(
                        `media not staged (${msg.platformMessageId}): ${staged.refused} file(s)`,
                    );
                }
                const params: PromptParams = {
                    workspace: asWorkspaceId(workspace),
                    sessionId: asSessionId(sessionId),
                    text: withUndeliveredNote(msg.text, staged),
                    // Media travels as attachments only. The composer inlines
                    // an image when the model can see one and names the file
                    // in the hidden tag either way — inlining here as well
                    // would send the model the same picture twice.
                    attachments: staged.ids,
                };
                const res = await this.hook.dispatchRpc?.(
                    createRpcRequest(id, RPC.sessionPrompt, params, id),
                );
                // Without this the failure is invisible: submit() still returns a
                // sessionId and the peer simply never receives a reply.
                if (res?.ok === false) {
                    if (res.error.code === ErrorCodes.SessionBusy) {
                        await this.deliverAsFollowUp(id, params, sessionId);
                    } else {
                        this.logger
                            .child({ sid: sessionId })
                            .warn(`prompt rejected: ${res.error.code} ${res.error.message}`);
                    }
                }

                return { sessionId }; // reply is P1 passive-reply; P0 always undefined
            },
        };
    }

    /**
     * Deliver a message as a follow-up after session.prompt rejected with
     * session_busy (a run is already in flight for this conversation).
     *
     * followUp rather than steer: a peer sending a second message while the
     * agent works is asking for it to be handled next, not for the current work
     * to be abandoned. steer would land at the next tool-batch checkpoint and
     * redirect a run that is midway through something the peer already asked
     * for — and a burst of chat messages would redirect it repeatedly.
     *
     * If the run ended between the rejection and the enqueue (mode "idle"),
     * retry the prompt once so the message is not left sitting in the inbox
     * unconsumed. Each attempt gets a fresh commandId: the dedup cache still
     * holds the original commandId's outcome and would replay the busy
     * rejection.
     */
    private async deliverAsFollowUp(
        id: string,
        params: PromptParams,
        sessionId: string,
    ): Promise<void> {
        const log = this.logger.child({ sid: sessionId });
        const queued = await this.hook.dispatchRpc?.(
            createRpcRequest(`${id}:followUp`, RPC.sessionFollowUp, params, `${id}:followUp`),
        );
        if (queued?.ok === false) {
            log.warn(`followUp fallback rejected: ${queued.error.code} ${queued.error.message}`);
            return;
        }
        if ((queued?.result as SteerResult | undefined)?.mode !== "idle") return;
        const retry = await this.hook.dispatchRpc?.(
            createRpcRequest(`${id}:retry`, RPC.sessionPrompt, params, `${id}:retry`),
        );
        if (retry?.ok === false) {
            log.warn(
                `prompt retry after idle followUp rejected: ${retry.error.code} ${retry.error.message}`,
            );
        }
    }
}

/** What staging produced, and how much of the message it could not deliver. */
interface StagedMedia {
    /** Ids the prompt names; absent when nothing was staged. */
    readonly ids: string[] | undefined;
    /** Files the sidecar would not take, so the caller can say so. */
    readonly refused: number;
}

/**
 * Stage the message's media so the prompt can name it.
 *
 * A channel cannot hand the sidecar a path: it holds the bytes, not a place
 * on this filesystem. Staging turns them into the ids a prompt names, and the
 * file lands in the session's attachment directory the same way a desktop
 * attachment does — one pipeline, one cleanup path.
 *
 * The workspace id namespaces staging, so it must be the one the prompt will
 * be composed under. A media file that cannot be staged is counted, not
 * thrown: the sender's text still arrives, and the caller reports the loss.
 */
async function stageMedia(
    media: readonly ChannelMediaRef[] | undefined,
    workspaceId: string,
): Promise<StagedMedia> {
    if (!media || media.length === 0) return { ids: undefined, refused: 0 };
    const ids: string[] = [];
    let refused = 0;
    for (const m of media) {
        // A URL or platform file id is not bytes: staging would have to fetch
        // what the channel only referenced, which this layer cannot do.
        if (m.source.kind !== "base64" || ids.length >= ATTACHMENT_MAX_COUNT) {
            refused++;
            continue;
        }
        try {
            const staged = await stageFromData(
                workspaceId,
                stagedName(m),
                m.source.data,
                m.source.mimeType,
                // A downloaded channel file is a file, not a paste: it gets
                // the desktop file ceiling rather than the paste one.
                ATTACHMENT_MAX_BYTES,
            );
            ids.push(staged.id);
        } catch {
            refused++;
        }
    }
    return { ids: ids.length > 0 ? ids : undefined, refused };
}

/**
 * The prompt text, with a note when some files did not arrive.
 *
 * A media-only message has no words of its own, so without the note the
 * prompt is empty — nothing to answer, and no signal that a file was lost. A
 * caption is the sender's words and stays. The note is appended either way,
 * because a partial delivery is invisible from the caption: the attachment
 * list names what arrived, never what did not.
 */
function withUndeliveredNote(text: string, staged: StagedMedia): string {
    if (staged.refused === 0) return text;
    const note = `[${staged.refused} attachment(s) could not be delivered — too large, an unsupported format, or too many.]`;
    return text.trim() === "" ? note : `${text}\n\n${note}`;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * The name the model reads.
 *
 * Channels send `image` / `file` with no extension, and the declared mime is
 * a guess from that same name. The extension comes from the bytes. A name
 * that already has one is kept.
 */
function stagedName(m: ChannelMediaRef): string {
    const given = m.name?.trim();
    const base = given && given.length > 0 ? given : mediaName(m);
    if (extname(base).length > 1) return base;
    const ext = sniffedExtension(m);
    return ext ? `${base}${ext}` : base;
}

/** The name a staged file carries when the channel sent none. */
function mediaName(m: ChannelMediaRef): string {
    const mime = m.source.kind === "base64" ? m.source.mimeType : "";
    const ext = extensionForMime(mime) ?? "";
    return isModelImageMime(mime) ? `image${ext}` : `file${ext}`;
}

function sniffedExtension(m: ChannelMediaRef): string | undefined {
    if (m.source.kind !== "base64") return undefined;
    const fromBytes = extensionFromBytes(decodeBase64Prefix(m.source.data));
    return fromBytes ?? extensionForMime(m.source.mimeType);
}

/** A short prefix is enough to sniff; the whole file is not decoded here. */
function decodeBase64Prefix(data: string): Buffer | undefined {
    const stripped = data.replace(/\s+/g, "").slice(0, 64);
    if (stripped.length < 4) return undefined;
    return Buffer.from(stripped, "base64");
}

function extensionFromBytes(head: Buffer | undefined): string | undefined {
    if (!head) return undefined;
    const sniffed = sniffImageMime(head);
    if (sniffed) return extensionForMime(sniffed);
    if (PDF_MAGIC.every((byte, index) => head[index] === byte)) return ".pdf";
    return undefined;
}
