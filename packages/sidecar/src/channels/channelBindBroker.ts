/**
 * Reverse-request broker for channel binding: the sidecar needs an answer from
 * the client (scan the QR, then type the pairing code) but the transport is
 * one-directional — ServerFrame is only a push or a response, and the client
 * dispatcher routes by `typeof ok === "boolean"`, so a server-initiated request
 * would be silently dropped as a push.
 *
 * Shape mirrors PermissionBroker: hold a pending map, return a Promise, emit a
 * push carrying the requestId, and resolve when a separate inbound RPC arrives.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/** Verification-code prompts expire well before the QR itself does. */
const DEFAULT_VERIFY_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long `connecting` may last before it is reported as an error.
 *
 * `connecting` is the one state no local event is guaranteed to leave: it ends
 * when the platform answers our auth, and a platform can decline in ways the
 * SDK doesn't classify (a WeCom rejection frame that omits `req_id` reaches
 * neither the `authenticated` nor the `error` handler). Without this the UI
 * spins forever with the reason only in the log. Generous enough to cover the
 * SDK's own reconnect back-off, which retries with exponential delay capped at
 * 30s.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 90 * 1000;

export type ChannelBindState =
    | "unbound"
    | "awaiting_scan"
    | "scanned"
    | "awaiting_verify_code"
    | "connecting"
    | "connected"
    | "expired"
    | "error";

export interface ChannelBindStatus {
    readonly channelId: string;
    readonly state: ChannelBindState;
    /** QR payload to render; present while awaiting_scan. */
    readonly qrUrl?: string;
    /** Pending verify-code requestId; present while awaiting_verify_code. */
    readonly requestId?: string;
    /** True when a verify code was rejected. */
    readonly retry?: boolean;
    readonly message?: string;
}

interface PendingVerify {
    channelId: string;
    resolve: (code: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Emits `status` on every state transition; the server subscribes and turns it
 * into a `channel.status_changed` push.
 */
export class ChannelBindBroker extends EventEmitter {
    private readonly pending = new Map<string, PendingVerify>();
    private readonly statuses = new Map<string, ChannelBindStatus>();
    /** Per-channel `connecting` watchdogs, keyed by channelId. */
    private readonly connectTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly verifyTimeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
        private readonly connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
    ) {
        super();
    }

    status(channelId: string): ChannelBindStatus {
        return this.statuses.get(channelId) ?? { channelId, state: "unbound" };
    }

    listStatuses(): ChannelBindStatus[] {
        return [...this.statuses.values()];
    }

    /** Records a state transition and notifies subscribers. Entering
     *  `connecting` arms a watchdog; any other transition disarms it. */
    setState(
        channelId: string,
        state: ChannelBindState,
        extra: Omit<ChannelBindStatus, "channelId" | "state"> = {},
    ): void {
        const next: ChannelBindStatus = { channelId, state, ...extra };
        this.statuses.set(channelId, next);
        this.armConnectWatchdog(channelId, state);
        this.emit("status", next);
    }

    /** Re-arms on every `connecting` entry: a reconnect restarts the clock
     *  rather than inheriting the previous attempt's remaining budget. */
    private armConnectWatchdog(channelId: string, state: ChannelBindState): void {
        const existing = this.connectTimers.get(channelId);
        if (existing) {
            clearTimeout(existing);
            this.connectTimers.delete(channelId);
        }
        if (state !== "connecting") return;
        const timer = setTimeout(() => {
            this.connectTimers.delete(channelId);
            // Guard against a transition that raced the timer's firing.
            if (this.statuses.get(channelId)?.state !== "connecting") return;
            this.setState(channelId, "error", {
                message: `connection timed out after ${Math.round(this.connectTimeoutMs / 1000)}s — check the channel credentials`,
            });
        }, this.connectTimeoutMs);
        // The sidecar daemon must be able to exit with a bind in flight.
        timer.unref?.();
        this.connectTimers.set(channelId, timer);
    }

    /** Publishes a QR payload for the client to render. */
    requestScan(channelId: string, qrUrl: string): void {
        this.setState(channelId, "awaiting_scan", { qrUrl });
    }

    /**
     * Blocks until the client submits a pairing code, or rejects on timeout so
     * the SDK's login flow fails instead of hanging forever.
     */
    async requestVerifyCode(channelId: string, isRetry: boolean): Promise<string> {
        // Supersede any earlier pending request for this channelId. The SDK
        // re-fires onVerifyCode(isRetry=true) after a wrong code; without
        // cancelling the prior entry, its timer would fire verifyTimeoutMs
        // later and setState("expired") over the fresh awaiting_verify_code.
        // The earlier request's Promise gets rejected with "superseded", which
        // the caller will surface as a thrown error — harmless because the
        // caller is already past that await.
        this.cancel(channelId, "superseded by new request");
        const requestId = randomUUID();
        return await new Promise<string>((resolve, reject) => {
            const finish = (fn: () => void) => {
                const entry = this.pending.get(requestId);
                if (entry) clearTimeout(entry.timer);
                this.pending.delete(requestId);
                fn();
            };
            const timer = setTimeout(() => {
                finish(() => {
                    this.setState(channelId, "expired", {
                        message: "verification code timed out",
                    });
                    reject(new Error("verification code request timed out"));
                });
            }, this.verifyTimeoutMs);
            this.pending.set(requestId, {
                channelId,
                resolve: (code) => finish(() => resolve(code)),
                reject: (e) => finish(() => reject(e)),
                timer,
            });
            this.setState(channelId, "awaiting_verify_code", { requestId, retry: isRetry });
        });
    }

    /** Resolves a pending verify-code request. Returns false if unknown/expired. */
    submitVerifyCode(requestId: string, code: string): boolean {
        const entry = this.pending.get(requestId);
        if (!entry) return false;
        entry.resolve(code);
        this.setState(entry.channelId, "connecting");
        return true;
    }

    /** Rejects every pending request for one channel and disarms its
     *  `connecting` watchdog — used by unbind / stop. Without disarming, a
     *  channel closed mid-connect would be flipped to `error` after the
     *  timeout, resurrecting a status for a channel that no longer runs. */
    cancel(channelId: string, reason = "binding cancelled"): void {
        const timer = this.connectTimers.get(channelId);
        if (timer) {
            clearTimeout(timer);
            this.connectTimers.delete(channelId);
        }
        for (const [requestId, entry] of [...this.pending]) {
            if (entry.channelId === channelId) {
                this.pending.delete(requestId);
                clearTimeout(entry.timer);
                entry.reject(new Error(reason));
            }
        }
    }

    /** Rejects all pending requests across all channels — used on shutdown. */
    cancelAll(reason = "sidecar shutting down"): void {
        const channelIds = new Set([
            ...[...this.pending.values()].map((e) => e.channelId),
            ...this.connectTimers.keys(),
        ]);
        for (const channelId of channelIds) {
            this.cancel(channelId, reason);
        }
    }

    /**
     * Reset a channel's binding state. Cancels any pending verify-code
     * requests and overwrites the cached status with `unbound` in one
     * call so subscribers never observe an "absent" intermediate.
     * Used by the unbind path; channel close still uses plain `cancel`.
     */
    reset(channelId: string, reason = "binding cancelled"): void {
        this.cancel(channelId, reason);
        this.setState(channelId, "unbound");
    }
}
