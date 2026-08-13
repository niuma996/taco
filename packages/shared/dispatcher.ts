/**
 * NDJSON frame dispatcher — core push/response pairing logic.
 *
 * Given a raw NDJSON line, recognize push frames (have `method`) vs response
 * frames; resolve responses to pending Promises; dispatch pushes to subscribers.
 *
 * Transport (spawn / Tauri invoke / other) is supplied by the caller. Must run
 * in the browser, so no `node:events` — a minimal pub/sub replaces EventEmitter.
 */

import type { ServerPush } from "@taco-ai/protocol";

type Listener<T> = (value: T) => void;

/** Minimal pub/sub — replaces node:events. Supports on/off and one-shot unsubscribe. */
class TinyEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();

    on(handler: Listener<T>): () => void {
        this.listeners.add(handler);
        return () => this.off(handler);
    }

    off(handler: Listener<T>): void {
        this.listeners.delete(handler);
    }

    emit(value: T): void {
        // Iterate over a copy so handlers may unsubscribe themselves.
        for (const h of [...this.listeners]) {
            try {
                h(value);
            } catch (err) {
                // Swallow — listener errors must not affect siblings; the warn channel catches them.
                console.error("dispatcher listener error:", err);
            }
        }
    }
}

interface PendingEntry {
    workspace: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

/** An error carrying the server-side `error.code` / `data` fields. */
export class RpcRemoteError extends Error {
    code: string;
    data?: unknown;
    constructor(code: string, message: string, data?: unknown) {
        super(message);
        this.name = "RpcRemoteError";
        this.code = code;
        this.data = data;
    }
}

export class FrameDispatcher {
    private readonly pending = new Map<string, PendingEntry>();
    private readonly pushBus = new TinyEmitter<ServerPush>();
    private readonly warnBus = new TinyEmitter<unknown>();

    /** Register a pending request — resolved when the server replies. */
    registerPending(id: string, workspace = "*"): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { workspace, resolve, reject });
        });
    }

    /** Reject one request, for transport send failures and request deadlines. */
    rejectPending(id: string, reason: Error): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(reason);
    }

    /** Reject only requests routed to a sidecar process that has exited. */
    rejectWorkspacePending(workspace: string, reason: Error): void {
        for (const [id, entry] of this.pending) {
            if (entry.workspace !== workspace) continue;
            this.pending.delete(id);
            entry.reject(reason);
        }
    }

    /** Reject every pending request (e.g. on client dispose). */
    rejectAllPending(reason: Error): void {
        for (const [, entry] of this.pending) {
            entry.reject(reason);
        }
        this.pending.clear();
    }

    /** Process one NDJSON object (already JSON.parse'd). */
    handleFrame(frame: unknown): void {
        try {
            const f = frame as {
                id?: unknown;
                method?: unknown;
                workspace?: unknown;
                session?: unknown;
                seq?: unknown;
                sessionKind?: unknown;
                params?: unknown;
                ok?: unknown;
                result?: unknown;
                error?: { code?: string; message?: string; data?: unknown };
            };

            // Structural split: a pull response always carries `ok: boolean`; a push frame does not.
            // Relying on "id not in pending" alone would let push frames that happen to carry an id collide with in-flight requests.
            const isResponse = typeof f.ok === "boolean";

            if (isResponse) {
                const entry = typeof f.id === "string" ? this.pending.get(f.id) : undefined;
                if (typeof f.id !== "string" || !entry) {
                    this.warnBus.emit({ unknownResponse: frame });
                    return;
                }
                this.pending.delete(f.id);
                if (f.ok) {
                    entry.resolve(f.result);
                } else {
                    const code = f.error?.code ?? "unknown";
                    const msg = f.error?.message ?? "rpc failed";
                    entry.reject(new RpcRemoteError(code, msg, f.error?.data));
                }
                return;
            }

            // Push frame: `method` is required, all other fields optional.
            if (typeof f.method === "string") {
                const push: ServerPush = {
                    id: typeof f.id === "string" ? f.id : undefined,
                    method: f.method,
                    workspace: typeof f.workspace === "string" ? f.workspace : "*",
                    session: typeof f.session === "string" ? f.session : undefined,
                    seq:
                        typeof f.seq === "number" && Number.isSafeInteger(f.seq)
                            ? f.seq
                            : undefined,
                    sessionKind:
                        f.sessionKind === "main" || f.sessionKind === "subagent"
                            ? f.sessionKind
                            : undefined,
                    params: f.params,
                };
                this.pushBus.emit(push);
                return;
            }

            this.warnBus.emit({ unknownFrame: frame });
        } catch (e) {
            this.warnBus.emit({ dispatchError: String(e), frame });
        }
    }

    /** Register a typed push-dispatch listener; returns an unsubscribe handle. */
    onPush(handler: (p: ServerPush) => void): () => void {
        return this.pushBus.on(handler);
    }

    /** Subscribe to parse/unknown-frame warnings. */
    onWarning(handler: (info: unknown) => void): () => void {
        return this.warnBus.on(handler);
    }
}

/** Splits NDJSON text into lines and feeds them to the dispatcher, handling partial-line buffering. */
export class NdjsonLineBuffer {
    private buffer = "";
    constructor(private readonly onLine: (line: string) => void) {}

    /** Append a stream chunk (may contain multiple or partial lines). */
    push(chunk: string): void {
        this.buffer = `${this.buffer}${chunk}`;
        let nl = this.buffer.indexOf("\n");
        while (nl >= 0) {
            const raw = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (raw) this.onLine(raw);
            nl = this.buffer.indexOf("\n");
        }
    }
}
