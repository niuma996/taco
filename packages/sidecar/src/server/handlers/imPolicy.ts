/**
 * imPolicy.* handlers — IM workspace policy admin surface.
 *
 * Reads via `imPolicy.get`, writes via three setters. All are process-level
 * (`ensureWorkspace=false`). Writes do NOT pass `{command:true}` — policy
 * merges are idempotent and the design-doc dedup window could otherwise
 * swallow a legitimate re-apply. Aligns with `settings.write`.
 */

import type {
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
} from "@taco-ai/protocol";
import {
    ErrorCodes,
    imPolicyClearChatOverrideSchema,
    imPolicyGetSchema,
    imPolicySetChannelDefaultSchema,
    imPolicySetChatOverrideSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { ImPolicyControl, ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

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

function requireChannelId(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new RpcHandlerError(ErrorCodes.InvalidParams, "channelId is required");
    }
    return value;
}

function requireChatTriple(value: unknown, field: "peerId" | "chatId"): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new RpcHandlerError(ErrorCodes.InvalidParams, `${field} is required`);
    }
    return value;
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
    registerMethod(
        RPC.imPolicyGet,
        false,
        async ({ server, params }: MethodCtx<ImPolicyGetParams>): Promise<ImPolicyGetResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = requireChannelId(params?.channelId);
            return imPolicy.get({ ...(params ?? {}), channelId });
        },
        { schema: imPolicyGetSchema },
    );

    registerMethod(
        RPC.imPolicySetChannelDefault,
        false,
        async ({
            server,
            params,
        }: MethodCtx<ImPolicySetChannelDefaultParams>): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = requireChannelId(params?.channelId);
            try {
                await imPolicy.setChannelDefault(channelId, params?.patch ?? {});
            } catch (e) {
                mapInvalidPatchError(e);
            }
            return { channelId };
        },
        { schema: imPolicySetChannelDefaultSchema },
    );

    registerMethod(
        RPC.imPolicySetChatOverride,
        false,
        async ({
            server,
            params,
        }: MethodCtx<ImPolicySetChatOverrideParams>): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = requireChannelId(params?.channelId);
            const peerId = requireChatTriple(params?.peerId, "peerId");
            const chatId = requireChatTriple(params?.chatId, "chatId");
            try {
                await imPolicy.setChatOverride({ channelId, peerId, chatId }, params?.patch ?? {});
            } catch (e) {
                mapInvalidPatchError(e);
            }
            return { channelId };
        },
        { schema: imPolicySetChatOverrideSchema },
    );

    registerMethod(
        RPC.imPolicyClearChatOverride,
        false,
        async ({
            server,
            params,
        }: MethodCtx<ImPolicyClearChatOverrideParams>): Promise<ImPolicyWriteResult> => {
            const imPolicy = requireImPolicy(server);
            const channelId = requireChannelId(params?.channelId);
            const hasTriple = !!(params?.peerId && params?.chatId);
            const hasKey = typeof params?.chatKey === "string" && params.chatKey.length > 0;
            if (hasTriple === hasKey) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "provide either peerId+chatId (live conversation) or chatKey (orphan)",
                );
            }
            if (hasKey) {
                const key = params?.chatKey;
                if (!key)
                    throw new RpcHandlerError(ErrorCodes.InvalidParams, "chatKey is required");
                await imPolicy.clearChatOverride({ chatKey: key }, channelId);
            } else {
                const peerId = params?.peerId;
                const chatId = params?.chatId;
                if (!peerId || !chatId) {
                    throw new RpcHandlerError(ErrorCodes.InvalidParams, "peerId+chatId required");
                }
                await imPolicy.clearChatOverride(
                    { route: { channelId, peerId, chatId } },
                    channelId,
                );
            }
            return { channelId };
        },
        { schema: imPolicyClearChatOverrideSchema },
    );
}
