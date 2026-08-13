/**
 * `im_channel` tag — context hook.
 *
 * Injects a hidden `<im_channel>` tag with the current IM channel's platform
 * type and instance id into every LLM context. Lets the model recognize which
 * channel it is answering on (e.g. wechat vs feishu, and which configured
 * instance) without exposing conversation identifiers.
 *
 * Scope is deliberately minimal: only `type` (manifest name) + `channelId`
 * (configured instance id). `peerId` / `chatId` are platform-side PII and
 * must never reach the prompt (see lib/logger.ts). Non-IM workspaces supply
 * no context — the hook is a no-op.
 *
 * The getter is invoked on every LLM call, so a channel reconfiguration
 * (settings.write) or a hot-reloaded channel list is reflected on the next
 * turn without re-attaching the session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createUserMessage, tagWrap } from "./builder.ts";

/** Safe projection of IM channel identity — the only fields allowed into the
 *  prompt. `type` = manifest name (wechat / feishu / …), `channelId` = the
 *  configured instance id (taco.json channels[].channelId). */
export interface ImChannelContext {
    readonly type: string;
    readonly channelId: string;
}

/**
 * Build a `context` hook that appends an `<im_channel>` tag to the tail of
 * every LLM context when `getContext()` yields a value. `undefined` (non-IM
 * workspace, unknown channel) → the hook does nothing. Appends to the tail
 * like `<env>` so the stable conversation prefix is untouched.
 */
export function buildImChannelContextHook(
    getContext: () => ImChannelContext | undefined,
): (event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined {
    return (event: { messages: AgentMessage[] }): { messages: AgentMessage[] } | undefined => {
        const ctx = getContext();
        if (!ctx) return undefined;
        const body = `type: ${ctx.type}\nchannel_id: ${ctx.channelId}`;
        event.messages.push(createUserMessage(tagWrap("im_channel", body)));
        return { messages: event.messages };
    };
}
