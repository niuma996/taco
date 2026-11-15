import type { ChannelStatusEntry } from "@taco-ai/protocol";

/** Module-scoped fan-out for channel.status_changed pushes from the App-side stream. */
const listeners = new Set<(channel: ChannelStatusEntry) => void>();

export function subscribeChannelStatusChanged(
    handler: (channel: ChannelStatusEntry) => void,
): () => void {
    listeners.add(handler);
    return () => {
        listeners.delete(handler);
    };
}

export function onChannelStatusChangedEvent(channel: ChannelStatusEntry): void {
    for (const listener of [...listeners]) listener(channel);
}
