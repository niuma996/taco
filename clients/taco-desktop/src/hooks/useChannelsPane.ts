import type { ChannelStatusEntry, ChannelsBindCreds, ChannelsListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

/** Manifest name for the WeCom channel. Mirror of the sidecar
 *  `CHANNEL_NAME_WECOM` constant — channels.* RPCs are addressed by
 *  manifest name in BUILTIN_CHANNEL_MANIFESTS, but there is no shared
 *  channels-name mirror (jobsRpc doesn't include channels.*). Kept local
 *  to the desktop until a second non-QR channel needs the same branch. */
export const CHANNEL_NAME_WECOM = "wecom";

export interface UseChannelsPaneResult {
    channelsStatus: ChannelsListResult | null;
    channelsLoading: boolean;
    channelsError: string | null;
    /** channelId currently mid-request, so its row can disable its controls. */
    channelsSavingId: string | null;
    bindChannel: (channelId: string, force?: boolean, creds?: ChannelsBindCreds) => Promise<void>;
    unbindChannel: (channelId: string) => Promise<void>;
    /** Reconnect using already-stored credentials. The only path back from a
     *  SDK-exhausted error (e.g. WeCom's "Max reconnect attempts exceeded")
     *  without forcing the user to retype the secret. */
    retryChannel: (channelId: string) => Promise<void>;
    submitVerifyCode: (requestId: string, code: string) => Promise<boolean>;
    createChannel: (name: string) => Promise<void>;
    /** True once an instance was created; channels load statically at startup. */
    channelsPendingRestart: boolean;
    channelsRestarting: boolean;
    restartForChannels: () => Promise<void>;
    refreshChannels: () => Promise<void>;
    /** Applied by the `channel.status_changed` push; keeps the pane live. */
    applyChannelStatus: (channel: ChannelStatusEntry) => void;
}

/** Loads channel status and drives bind / unbind / verify-code for the pane. */
export function useChannelsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    restartSidecar: () => Promise<void>,
): UseChannelsPaneResult {
    const [channelsStatus, setChannelsStatus] = useState<ChannelsListResult | null>(null);
    const [channelsLoading, setChannelsLoading] = useState(false);
    const [channelsSavingId, setChannelsSavingId] = useState<string | null>(null);
    const [channelsPendingRestart, setChannelsPendingRestart] = useState(false);
    const [channelsRestarting, setChannelsRestarting] = useState(false);
    const { error: channelsError, fail: failWith, clearError } = useAutoClearError();

    const refreshChannels = useCallback(async (): Promise<void> => {
        setChannelsLoading(true);
        clearError();
        try {
            setChannelsStatus(await client.channelsList());
        } catch (e) {
            failWith(e);
        } finally {
            setChannelsLoading(false);
        }
    }, [client, clearError, failWith]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        void refreshChannels();
    }, [active, activeCwd, refreshChannels]);

    /**
     * Merges one channel's state in place. Binding progress arrives as pushes,
     * so re-fetching the whole list on every transition would flicker the pane.
     */
    const applyChannelStatus = useCallback((channel: ChannelStatusEntry): void => {
        setChannelsStatus((prev) => {
            if (!prev) return prev;
            const exists = prev.configured.some((c) => c.channelId === channel.channelId);
            return {
                ...prev,
                configured: exists
                    ? prev.configured.map((c) => (c.channelId === channel.channelId ? channel : c))
                    : [...prev.configured, channel],
            };
        });
    }, []);

    const bindChannel = useCallback(
        async (channelId: string, force?: boolean, creds?: ChannelsBindCreds): Promise<void> => {
            setChannelsSavingId(channelId);
            clearError();
            try {
                // Resolves as soon as the flow starts; the QR code and every
                // later transition arrive via channel.status_changed. The
                // returned state is deliberately discarded — an awaiting_scan
                // push can land before this resolves, and writing the stale
                // `connecting` back would drop the QR code that just arrived.
                await client.channelsBind({ channelId, force, creds });
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, clearError, failWith],
    );

    const unbindChannel = useCallback(
        async (channelId: string): Promise<void> => {
            setChannelsSavingId(channelId);
            clearError();
            try {
                await client.channelsUnbind({ channelId });
                await refreshChannels();
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, clearError, refreshChannels, failWith],
    );

    const retryChannel = useCallback(
        async (channelId: string): Promise<void> => {
            setChannelsSavingId(channelId);
            clearError();
            try {
                await client.channelsRetry({ channelId });
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, clearError, failWith],
    );

    const createChannel = useCallback(
        async (name: string): Promise<void> => {
            setChannelsSavingId(name);
            clearError();
            try {
                const { requiresRestart } = await client.channelsCreate({ name });
                if (requiresRestart) setChannelsPendingRestart(true);
                await refreshChannels();
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, clearError, refreshChannels, failWith],
    );

    const restartForChannels = useCallback(async (): Promise<void> => {
        setChannelsRestarting(true);
        try {
            await restartSidecar();
            setChannelsPendingRestart(false);
            await refreshChannels();
        } catch (e) {
            failWith(e);
        } finally {
            setChannelsRestarting(false);
        }
    }, [restartSidecar, refreshChannels, failWith]);

    const submitVerifyCode = useCallback(
        async (requestId: string, code: string): Promise<boolean> => {
            clearError();
            try {
                const { accepted } = await client.channelsSubmitVerifyCode({ requestId, code });
                return accepted;
            } catch (e) {
                failWith(e);
                return false;
            }
        },
        [client, clearError, failWith],
    );

    return {
        channelsStatus,
        channelsLoading,
        channelsError,
        channelsSavingId,
        bindChannel,
        unbindChannel,
        retryChannel,
        submitVerifyCode,
        createChannel,
        channelsPendingRestart,
        channelsRestarting,
        restartForChannels,
        refreshChannels,
        applyChannelStatus,
    };
}
