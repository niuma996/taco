import type { ServerFrame, Transport } from "../../src/server/transport.ts";

export class InMemoryTransport implements Transport {
    readonly sent: ServerFrame[] = [];
    private handler?: (raw: string) => void;
    private waiters: { target: number; resolve: (f: ServerFrame[]) => void }[] = [];

    async open(): Promise<void> {}

    async send(frame: ServerFrame): Promise<void> {
        this.sent.push(frame);
        // Wakes waiters that have already met their target count (promise+resolver queue, not polling).
        this.waiters = this.waiters.filter((w) => {
            if (this.sent.length >= w.target) {
                w.resolve(this.sent.slice(0, w.target));
                return false;
            }
            return true;
        });
    }

    onRequest(handler: (raw: string) => void): void {
        this.handler = handler;
    }

    async close(): Promise<void> {}

    /** Simulates an incoming client request. */
    simulateRequest(raw: string): void {
        this.handler?.(raw);
    }

    /** Returns the last N frames; defaults to all. */
    latestFrames(n?: number): ServerFrame[] {
        return n ? this.sent.slice(-n) : this.sent;
    }

    /** Waits until sent count reaches target (event-driven, not polling). */
    async waitForPushCount(target: number, timeoutMs = 2000): Promise<ServerFrame[]> {
        if (this.sent.length >= target) return this.sent.slice(0, target);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new Error(`timeout waiting for ${target} pushes, got ${this.sent.length}`),
                    ),
                timeoutMs,
            );
            this.waiters.push({
                target,
                resolve: (f) => {
                    clearTimeout(timer);
                    resolve(f);
                },
            });
        });
    }
}
