import type { ImConversationEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import { CHANNEL_NAME_WECOM, useChannelsPane } from "../../hooks/useChannelsPane";
import { subscribeChannelStatusChanged } from "../../lib/channelEvents";
import type { TacoClient } from "../../lib/clients/tacoClient";
import { ChannelsPane } from "../../views/ChannelsPane";
import { ChannelBindDialog } from "../ChannelBindDialog";

export interface ConfigurationChannelsControllerProps {
    active: boolean;
    client: TacoClient;
    activeCwd: string | undefined;
    restartSidecar: () => Promise<void>;
    conversations: ImConversationEntry[] | null;
    conversationsLoading: boolean;
    conversationsError: string | null;
    conversationsUnread: number;
    markConversationsSeen: () => void;
    onOpenConversation: (cwd: string, sessionId: string) => void;
}

export function ConfigurationChannelsController(props: ConfigurationChannelsControllerProps) {
    const {
        active,
        client,
        activeCwd,
        restartSidecar,
        conversations,
        conversationsLoading,
        conversationsError,
        conversationsUnread,
        markConversationsSeen,
        onOpenConversation,
    } = props;
    const channels = useChannelsPane(client, active, activeCwd, restartSidecar);
    const [bindingChannelId, setBindingChannelId] = useState<string | null>(null);

    useEffect(
        () => subscribeChannelStatusChanged(channels.applyChannelStatus),
        [channels.applyChannelStatus],
    );

    const isWeComChannel = (channelId: string): boolean =>
        channels.channelsStatus?.configured.find((channel) => channel.channelId === channelId)
            ?.name === CHANNEL_NAME_WECOM;
    const bindingChannel =
        channels.channelsStatus?.configured.find(
            (channel) => channel.channelId === bindingChannelId,
        ) ?? null;

    return (
        <>
            {active && (
                <ChannelsPane
                    client={client}
                    status={channels.channelsStatus}
                    loading={channels.channelsLoading}
                    error={channels.channelsError}
                    savingId={channels.channelsSavingId}
                    installingId={channels.channelsInstallingId}
                    pendingRestart={channels.channelsPendingRestart}
                    restarting={channels.channelsRestarting}
                    onCreate={(name) => void channels.createChannel(name)}
                    onRestart={() => void channels.restartForChannels()}
                    onBind={(channelId) => {
                        setBindingChannelId(channelId);
                        if (!isWeComChannel(channelId)) void channels.bindChannel(channelId);
                    }}
                    onRebind={(channelId) => {
                        setBindingChannelId(channelId);
                        if (!isWeComChannel(channelId)) {
                            void channels.bindChannel(channelId, true);
                        }
                    }}
                    onRetry={(channelId) => void channels.retryChannel(channelId)}
                    onInstallSdk={(channelId) => void channels.installChannelSdk(channelId)}
                    onUnbind={(channelId) => void channels.unbindChannel(channelId)}
                    conversations={conversations}
                    conversationsLoading={conversationsLoading}
                    conversationsError={conversationsError}
                    conversationsUnread={conversationsUnread}
                    markConversationsSeen={markConversationsSeen}
                    onOpenConversation={onOpenConversation}
                    activeCwd={activeCwd}
                />
            )}
            <ChannelBindDialog
                open={bindingChannelId !== null}
                channel={bindingChannel}
                error={channels.channelsError}
                onSubmitVerifyCode={channels.submitVerifyCode}
                onBindCreds={(creds) => {
                    if (bindingChannelId === null) return;
                    // Rebind must replace existing credentials instead of reusing the stored token.
                    const force = bindingChannel?.state === "connected";
                    void channels.bindChannel(bindingChannelId, force, creds);
                }}
                onCancel={() => setBindingChannelId(null)}
            />
        </>
    );
}
