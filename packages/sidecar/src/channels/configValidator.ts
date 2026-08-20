/** channelId validity: no /, %, . — guarantees makeImCwd concatenation is safe. */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidChannelId(channelId: string): boolean {
    return CHANNEL_ID_PATTERN.test(channelId);
}
