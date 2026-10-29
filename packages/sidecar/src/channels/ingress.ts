import { extname } from "node:path";
import type { PromptParams, SteerResult } from "@taco-ai/protocol";
import {
    ATTACHMENT_MAX_COUNT,
    asSessionId,
    asWorkspaceId,
    createRpcRequest,
    ErrorCodes,
    RPC,
} from "@taco-ai/protocol";
import { stageFromData } from "../attachments/attachmentStore.ts";
import { sniffImageMime } from "../attachments/mimeType.ts";
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
                const params: PromptParams = {
                    workspace: asWorkspaceId(workspace),
                    sessionId: asSessionId(sessionId),
                    text: msg.text,
                    // Media travels as attachments only. The composer inlines
                    // an image when the model can see one and names the file
                    // in the hidden tag either way — inlining here as well
                    // would send the model the same picture twice.
                    attachments: await stageMedia(msg.media, workspace),
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

/**
 * Stage the message's media so the prompt can name it.
 *
 * A channel cannot hand the sidecar a path: it holds the bytes, not a place
 * on this filesystem. Staging turns them into the ids a prompt names, and the
 * file lands in the session's attachment directory the same way a desktop
 * attachment does — one pipeline, one cleanup path.
 *
 * The workspace id namespaces staging, so it must be the one the prompt will
 * be composed under. A media file that cannot be staged is dropped: the
 * sender's text still arrives.
 */
async function stageMedia(
    media: readonly ChannelMediaRef[] | undefined,
    workspaceId: string,
): Promise<string[] | undefined> {
    if (!media || media.length === 0) return undefined;
    const ids: string[] = [];
    for (const m of media) {
        if (m.source.kind !== "base64") continue;
        try {
            const staged = await stageFromData(
                workspaceId,
                stagedName(m),
                m.source.data,
                m.source.mimeType,
            );
            ids.push(staged.id);
        } catch {
            // A file the platform would not let us stage is dropped rather
            // than failing the whole message.
        }
        if (ids.length >= ATTACHMENT_MAX_COUNT) break;
    }
    return ids.length > 0 ? ids : undefined;
}

/** Mime to extension, shared by the fallback name and the sniffed suffix. */
const EXTENSION_BY_MIME: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
};

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
    const ext = EXTENSION_BY_MIME[mime];
    if (ext === ".pdf") return `file${ext}`;
    if (ext) return `image${ext}`;
    return "file";
}

function sniffedExtension(m: ChannelMediaRef): string | undefined {
    if (m.source.kind !== "base64") return undefined;
    const fromBytes = extensionFromBytes(decodeBase64Prefix(m.source.data));
    return fromBytes ?? EXTENSION_BY_MIME[m.source.mimeType];
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
    if (sniffed) return EXTENSION_BY_MIME[sniffed];
    if (PDF_MAGIC.every((byte, index) => head[index] === byte)) return ".pdf";
    return undefined;
}
