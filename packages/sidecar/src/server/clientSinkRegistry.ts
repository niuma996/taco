/**
 * ClientSinkRegistry — process-level fan-out of push frames to every
 * connected desktop's transport.
 *
 * After the daemon-ownership refactor the IM host owns IM workspaces, but
 * its `emitPush` only hits NullTransport — so an already-open desktop IM
 * view went stale on every new peer message or mid-turn update. This
 * registry lets the host fan out the same frame to every desktop's
 * NDJSON transport. The desktop filters frames by session id at the
 * application layer, so fanning out unconditionally is correct and
 * matches the existing wire protocol.
 *
 * Use:
 *  - `runDaemon` constructs one registry and passes it via SharedSidecarDeps.
 *  - Each SidecarServer registers its transport on `start()` and removes
 *    it on `stop()` (the host registers its NullTransport — no-op).
 *  - The host's `emitPush` for `im://` workspaces calls `fanout(frame)`,
 *    which sends the same frame to every registered sink.
 *
 * Failure isolation: a sink that throws (or whose `send` rejects) must
 * not break the others. Each send is awaited via `.catch(() => {})` so
 * unhandled rejections never escape.
 *
 * Ownership: this is a daemon-process singleton. Stdio / test sidecars
 * don't construct one — they have a single SidecarServer whose own
 * transport is the only sink, so fanout is unnecessary and `emitPush`
 * falls back to the existing `void this.getTransport().send(frame)`
 * path. The registry is an opt-in addition; the absence of one is the
 * pre-Phase-2 behaviour byte-for-byte.
 */

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

    /** Send `frame` to every registered sink. Best-effort per sink. */
    fanout(frame: ServerFrame): void {
        for (const sink of this.sinks) {
            const p = sink.send(frame);
            // Sink implementations are expected to log their own failures;
            // we just make sure unhandled rejections from one sink can't
            // bring down the host or starve the others.
            if (p && typeof (p as Promise<unknown>).catch === "function") {
                (p as Promise<unknown>).catch(() => {});
            }
        }
    }
}
