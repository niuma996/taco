/** Broadcasts runtime pushes to initialized clients without coupling their lifetimes. */

import type { ServerFrame, Transport } from "./transport.ts";

export class ClientSinkRegistry {
    private readonly sinks = new Set<Transport>();

    /** Register a transport as a fan-out sink. Idempotent. */
    add(transport: Transport): void {
        this.sinks.add(transport);
    }

    /** Remove a transport. Idempotent. Safe to call after close. */
    remove(transport: Transport): void {
        this.sinks.delete(transport);
    }

    /** Current sink count — used by tests. */
    size(): number {
        return this.sinks.size;
    }

    /** True when a client that can answer prompts is connected. */
    hasClient(): boolean {
        for (const sink of this.sinks) if (sink.interactive !== false) return true;
        return false;
    }

    /** Send `frame` to every registered sink. Best-effort per sink. */
    fanout(frame: ServerFrame, exclude?: Transport): void {
        for (const sink of this.sinks) {
            if (sink === exclude) continue;
            let p: Promise<void>;
            try {
                p = sink.send(frame);
            } catch {
                continue;
            }
            // Sink implementations are expected to log their own failures;
            // we just make sure unhandled rejections from one sink can't
            // bring down the host or starve the others.
            if (p && typeof (p as Promise<unknown>).catch === "function") {
                (p as Promise<unknown>).catch(() => {});
            }
        }
    }
}
