/**
 * NullTransport — implements `Transport` as a sink. Used by the daemon-resident
 * IM host: it needs `start()`'s side effects (broadcast subscriptions,
 * loadAndStart) but serves no remote client, so its transport discards frames
 * silently. Real IM outbound flows through `channelRegistry.push` (see server.ts
 * emitPush), not through this transport.
 */

import type { ServerFrame, Transport } from "./transport.ts";

export class NullTransport implements Transport {
    async open(): Promise<void> {}

    async close(): Promise<void> {}

    async send(_frame: ServerFrame): Promise<void> {}

    onRequest(_handler: (raw: string) => void): void {
        // Intentionally a no-op: the resident host never reads inbound frames.
        // All RPCs reach it through `dispatchRpc`, which bypasses onRequest.
    }
}
