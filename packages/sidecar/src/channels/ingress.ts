import type { ImageInput } from "@taco-ai/protocol";
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
                const res = await this.hook.dispatchRpc?.({
                    id,
                    commandId: id,
                    method: "session.prompt",
                    params: {
                        workspace,
                        sessionId,
                        text: msg.text,
                        images: msg.media
                            ?.filter((m) => m.kind === "image")
                            .map(toImageInput)
                            .filter((i): i is ImageInput => i !== undefined),
                    },
                });
                // Without this the failure is invisible: submit() still returns a
                // sessionId and the peer simply never receives a reply.
                if (res?.ok === false) {
                    this.logger
                        .child({ sid: sessionId })
                        .warn(`prompt rejected: ${res.error.code} ${res.error.message}`);
                }

                return { sessionId }; // reply is P1 passive-reply; P0 always undefined
            },
        };
    }
}

/** ChannelMediaRef -> ImageInput. P0 handles only { kind: "base64" }; url/fileId deferred to P1. */
function toImageInput(m: ChannelMediaRef): ImageInput | undefined {
    if (m.source.kind === "base64") {
        return { type: "image", data: m.source.data, mimeType: m.source.mimeType };
    }
    return undefined;
}
