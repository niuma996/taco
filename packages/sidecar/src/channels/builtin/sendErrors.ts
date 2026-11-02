/**
 * Turns an SDK send failure into a `SendOutboundResult`.
 *
 * Neither SDK distinguishes "try again" from "never going to work" in its
 * types alone, so this reads the shapes they do expose (`code`, `httpStatus`,
 * `errcode`, node error codes) and falls back to *retryable*. Retrying a send
 * that cannot succeed costs a few backoff slots and ends in `retryExhausted`;
 * giving up on one that could have succeeded loses the message. The default
 * errs toward the cheaper mistake.
 */

import type { SendOutboundResult } from "../types.ts";

/** Node/undici error codes that mean the network, not the request, failed. */
const TRANSIENT_NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
]);

/** iLink `errcode` for an expired bot session: only a re-bind fixes it. */
const WECHAT_SESSION_EXPIRED = -14;

interface ErrorShape {
    code?: unknown;
    httpStatus?: unknown;
    errcode?: unknown;
    name?: unknown;
    message?: unknown;
}

function shapeOf(error: unknown): ErrorShape {
    return typeof error === "object" && error !== null ? (error as ErrorShape) : {};
}

function messageOf(error: unknown): string {
    const m = shapeOf(error).message;
    return typeof m === "string" ? m : String(error);
}

/** A short, log-safe code: never the message, which can carry platform text. */
function codeOf(error: unknown, fallback: string): string {
    const shape = shapeOf(error);
    if (typeof shape.errcode === "number") return `errcode_${shape.errcode}`;
    if (typeof shape.httpStatus === "number") return `http_${shape.httpStatus}`;
    if (typeof shape.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(shape.code)) {
        return shape.code.toLowerCase();
    }
    return fallback;
}

export function classifySendError(error: unknown): SendOutboundResult {
    const shape = shapeOf(error);

    // The WeChat SDK refuses a send to a user who never wrote first: it has no
    // context token for them, and none will appear by waiting.
    if (shape.name === "NoContextError" || shape.code === "NO_CONTEXT") {
        return { kind: "permanentFailure", code: "no_context" };
    }

    if (shape.errcode === WECHAT_SESSION_EXPIRED) {
        // The bot's login is gone. That is a channel state, not a bad target:
        // once the user re-binds, the same message can go out.
        return { kind: "unavailable", code: "session_expired" };
    }

    const status = typeof shape.httpStatus === "number" ? shape.httpStatus : undefined;
    if (status !== undefined) {
        if (status === 429) return { kind: "retryable", code: codeOf(error, "http_429") };
        if (status >= 500) return { kind: "retryable", code: codeOf(error, "http_5xx") };
        if (status === 401 || status === 403) {
            return { kind: "unavailable", code: codeOf(error, "unauthorized") };
        }
        if (status >= 400) return { kind: "permanentFailure", code: codeOf(error, "http_4xx") };
    }

    if (shape.name === "AuthError") return { kind: "unavailable", code: "auth" };

    if (typeof shape.code === "string" && TRANSIENT_NETWORK_CODES.has(shape.code)) {
        return { kind: "retryable", code: shape.code.toLowerCase() };
    }
    if (shape.name === "TransportError") return { kind: "retryable", code: "transport" };

    // WeCom's WSClient rejects with plain Errors; "not connected" and ack
    // timeouts are the two it produces for a send in flight.
    const message = messageOf(error).toLowerCase();
    if (message.includes("not connected") || message.includes("not authenticated")) {
        return { kind: "unavailable", code: "not_connected" };
    }
    if (message.includes("timeout") || message.includes("timed out")) {
        return { kind: "retryable", code: "timeout" };
    }

    return { kind: "retryable", code: codeOf(error, "send_failed") };
}
