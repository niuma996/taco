/**
 * imPolicy.* handlers — IM workspace policy admin surface.
 *
 * Reads via `imPolicy.get`, writes via three setters. All are process-level
 * (`ensureWorkspace=false`). Writes do NOT pass `{command:true}` — policy
 * merges are idempotent and the design-doc dedup window could otherwise
 * swallow a legitimate re-apply. Aligns with `settings.write`.
 */

import type { ImPolicyGetResult, ImPolicyWriteResult } from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";
import type { ImPolicyControl, ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/** IM policy control is wired at startup; absent means this host does not support it. */
function requireImPolicy(server: ServerRpcSurface): ImPolicyControl {
    if (!server.imPolicy) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidState,
            "imPolicy is not available on this server",
        );
    }
    return server.imPolicy;
}

/**
 * Translate a store validation error (thrown from `validatePartial` inside
 * `SidecarServer.setImChannelDefault / setImChatOverride`) into a coded
 * invalid_params response. Without this, normalizeError would flatten it to
 * `internal` and the desktop form would lose the field-level reason.
 */
function mapInvalidPatchError(e: unknown): never {
    throw new RpcHandlerError(ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
}

export function registerImPolicyHandlers(): void {
    registerMethod("imPolicyGet", false, async ({ server, params }): Promise<ImPolicyGetResult> => {
        const imPolicy = requireImPolicy(server);
        return imPolicy.get(params);
    });

    registerMethod(
        "imPolicySetChannelDefault",
        false,
        async ({ server, params }): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = params.channelId;
            try {
                await imPolicy.setChannelDefault(channelId, params.patch);
            } catch (e) {
                mapInvalidPatchError(e);
            }
            return { channelId };
        },
    );

    registerMethod(
        "imPolicySetChatOverride",
        false,
        async ({ server, params }): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = params.channelId;
            const peerId = params.peerId;
            const chatId = params.chatId;
            try {
                await imPolicy.setChatOverride({ channelId, peerId, chatId }, params.patch);
            } catch (e) {
                mapInvalidPatchError(e);
            }
            return { channelId };
        },
    );

    registerMethod(
        "imPolicyClearChatOverride",
        false,
        async ({ server, params }): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = params.channelId;
            const hasTriple = !!(params.peerId && params.chatId);
            const hasKey = !!params.chatKey;
            if (hasTriple === hasKey) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "provide either peerId+chatId (live conversation) or chatKey (orphan)",
                );
            }
            if (hasKey) {
                await imPolicy.clearChatOverride({ chatKey: params.chatKey as string }, channelId);
            } else {
                await imPolicy.clearChatOverride(
                    {
                        route: {
                            channelId,
                            peerId: params.peerId as string,
                            chatId: params.chatId as string,
                        },
                    },
                    channelId,
                );
            }
            return { channelId };
        },
    );
}
