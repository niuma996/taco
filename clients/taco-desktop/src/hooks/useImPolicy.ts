/**
 * useImPolicy — load + edit IM workspace policy for a single channel/chat.
 *
 * Same gating/error pattern as `useConversationsPane`:
 * - local `error` string, auto-cleared after 4s
 * - never throws out of callbacks; the dialog reads `error` from state
 *
 * The hook is per-dialog — when the dialog opens the parent calls `load`,
 * when the user saves it calls one of the write helpers, and on success
 * the dialog closes. The `onImPolicyChanged` push callback re-loads
 * silently so other desktop windows stay in sync.
 */
import type { ImPolicyGetResult, ImRoute, ImWorkspacePolicyPatch } from "@taco-ai/protocol";
import { useCallback, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import { useAutoClearError } from "./useAutoClearError";

export interface UseImPolicyResult {
    data: ImPolicyGetResult | null;
    loading: boolean;
    saving: boolean;
    error: string | null;
    /** Pull fresh state for a scope. `peerId`+`chatId` are optional — pass
     *  them together to populate the chat-specific row, omit to render the
     *  channel-default view. */
    load: (
        channelId: string,
        peerId?: string,
        chatId?: string,
    ) => Promise<ImPolicyGetResult | null>;
    saveChannelDefault: (channelId: string, patch: ImWorkspacePolicyPatch) => Promise<boolean>;
    saveChatOverride: (route: ImRoute, patch: ImWorkspacePolicyPatch) => Promise<boolean>;
    clearChatOverride: (route: ImRoute) => Promise<boolean>;
    /** Drop a single chat override by its raw chats-map key. Used by the
     *  channel-level dialog to clear orphan overrides (the conversation
     *  is no longer routed, so the route cannot be reconstructed). */
    clearChatOverrideByKey: (channelId: string, key: string) => Promise<boolean>;
    /** Called from the `im.policy_changed` push handler — reloads the
     *  current scope if its channel matches. */
    onImPolicyChanged: (channelId: string) => void;
}

export function useImPolicy(client: TacoClient, currentScope: ImRoute | null): UseImPolicyResult {
    const [data, setData] = useState<ImPolicyGetResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // Tracks the channelId the dialog last pulled. `currentScope` is null in
    // channel-scope mode, so push reload needs its own anchor instead of
    // reading scope.channelId (which would be undefined).
    const [loadedChannelId, setLoadedChannelId] = useState<string | null>(null);

    const { error, fail: failWith } = useAutoClearError();

    const load = useCallback(
        async (channelId: string, peerId?: string, chatId?: string) => {
            setLoading(true);
            try {
                const result = await client.imPolicyGet({ channelId, peerId, chatId });
                setData(result);
                setLoadedChannelId(channelId);
                return result;
            } catch (e) {
                failWith(e);
                return null;
            } finally {
                setLoading(false);
            }
        },
        [client, failWith],
    );

    const saveChannelDefault = useCallback(
        async (channelId: string, patch: ImWorkspacePolicyPatch) => {
            setSaving(true);
            try {
                await client.imPolicySetChannelDefault({ channelId, patch });
                // The server broadcasts `im.policy_changed`; we re-pull in onImPolicyChanged.
                return true;
            } catch (e) {
                failWith(e);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [client, failWith],
    );

    const saveChatOverride = useCallback(
        async (route: ImRoute, patch: ImWorkspacePolicyPatch) => {
            setSaving(true);
            try {
                await client.imPolicySetChatOverride({ ...route, patch });
                return true;
            } catch (e) {
                failWith(e);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [client, failWith],
    );

    const clearChatOverride = useCallback(
        async (route: ImRoute) => {
            setSaving(true);
            try {
                await client.imPolicyClearChatOverride({ ...route });
                return true;
            } catch (e) {
                failWith(e);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [client, failWith],
    );

    const clearChatOverrideByKey = useCallback(
        async (channelId: string, key: string) => {
            setSaving(true);
            try {
                await client.imPolicyClearChatOverride({ channelId, chatKey: key });
                return true;
            } catch (e) {
                failWith(e);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [client, failWith],
    );

    const onImPolicyChanged = useCallback(
        (channelId: string) => {
            if (channelId !== loadedChannelId) return;
            void load(channelId, currentScope?.peerId, currentScope?.chatId);
        },
        [loadedChannelId, currentScope, load],
    );

    return {
        data,
        loading,
        saving,
        error,
        load,
        saveChannelDefault,
        saveChatOverride,
        clearChatOverride,
        clearChatOverrideByKey,
        onImPolicyChanged,
    };
}
