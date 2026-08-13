import type { ChannelStatusEntry, ChannelsListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

export interface UseChannelsPaneResult {
    channelsStatus: ChannelsListResult | null;
    channelsLoading: boolean;
    channelsError: string | null;
    /** channelId currently mid-request, so its row can disable its controls. */
    channelsSavingId: string | null;
    bindChannel: (channelId: string, force?: boolean) => Promise<void>;
    unbindChannel: (channelId: string) => Promise<void>;
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
    const [channelsError, setChannelsError] = useState<string | null>(null);
    const [channelsSavingId, setChannelsSavingId] = useState<string | null>(null);
    const [channelsPendingRestart, setChannelsPendingRestart] = useState(false);
    const [channelsRestarting, setChannelsRestarting] = useState(false);

    const failWith = useCallback((e: unknown) => {
        setChannelsError(e instanceof Error ? e.message : String(e));
        window.setTimeout(() => setChannelsError(null), 4000);
    }, []);

    const refreshChannels = useCallback(async (): Promise<void> => {
        setChannelsLoading(true);
        setChannelsError(null);
        try {
            setChannelsStatus(await client.channelsList());
        } catch (e) {
            setChannelsError(e instanceof Error ? e.message : String(e));
        } finally {
            setChannelsLoading(false);
        }
    }, [client]);

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
        async (channelId: string, force?: boolean): Promise<void> => {
            setChannelsSavingId(channelId);
            setChannelsError(null);
            try {
                // Resolves as soon as the flow starts; the QR code and every
                // later transition arrive via channel.status_changed. The
                // returned state is deliberately discarded — an awaiting_scan
                // push can land before this resolves, and writing the stale
                // `connecting` back would drop the QR code that just arrived.
                await client.channelsBind({ channelId, force });
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, failWith],
    );

    const unbindChannel = useCallback(
        async (channelId: string): Promise<void> => {
            setChannelsSavingId(channelId);
            setChannelsError(null);
            try {
                await client.channelsUnbind({ channelId });
                await refreshChannels();
            } catch (e) {
                failWith(e);
            } finally {
                setChannelsSavingId(null);
            }
        },
        [client, refreshChannels, failWith],
    );

    const createChannel = useCallback(
        async (name: string): Promise<void> => {
            setChannelsSavingId(name);
            setChannelsError(null);
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
        [client, refreshChannels, failWith],
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
            setChannelsError(null);
            try {
                const { accepted } = await client.channelsSubmitVerifyCode({ requestId, code });
                return accepted;
            } catch (e) {
                failWith(e);
                return false;
            }
        },
        [client, failWith],
    );

    return {
        channelsStatus,
        channelsLoading,
        channelsError,
        channelsSavingId,
        bindChannel,
        unbindChannel,
        submitVerifyCode,
        createChannel,
        channelsPendingRestart,
        channelsRestarting,
        restartForChannels,
        refreshChannels,
        applyChannelStatus,
    };
}
