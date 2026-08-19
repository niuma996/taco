/**
 * Small pure helpers shared by the per-connection `SidecarServer` (in
 * `server.ts`) and any future callers that need to mint RpcResponse frames
 * or normalise thrown errors into them.
 *
 * Pulled out of `server.ts` so the helpers can be unit-tested in
 * isolation and the giant class file shrinks below the 1000-line cap.
 */

import { ErrorCodes, type RpcResponse } from "@taco-ai/protocol";
import { RpcHandlerError } from "./methodRegistry.ts";

/**
 * Internal envelope for command-execution results: either the raw
 * success payload or an already-shaped error. Lives in this module
 * because both `toCommandOutcome` and `withRequestId` move between
 * RpcResponse and CommandOutcome, and keeping them next to the helpers
 * avoids a cyclic import with `server.ts`.
 */
export type CommandOutcome =
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string; data?: unknown } };

/** Wrap an `RpcResponse` in the leaner `CommandOutcome` shape the
 *  active-turn cache stores. */
export function toCommandOutcome(response: RpcResponse): CommandOutcome {
    return response.ok
        ? { ok: true, result: response.result }
        : { ok: false, error: response.error };
}

/** Attach an RPC `id` back to a `CommandOutcome` to mint a wire frame. */
export function withRequestId(id: string, outcome: CommandOutcome): RpcResponse {
    return outcome.ok
        ? { id, ok: true, result: outcome.result }
        : { id, ok: false, error: outcome.error };
}

/** Mint a success frame for `id`. */
export function ok(id: string, result: unknown): RpcResponse {
    return { id, ok: true, result };
}

/** Mint an error frame for `id`. */
export function err(id: string, code: string, message: string, data?: unknown): RpcResponse {
    return { id, ok: false, error: { code, message, data } };
}

/** Build the routing key (`workspace\0sessionId`) the active-turn
 *  cache uses to coalesce turns across RPC frames, or `undefined` if
 *  `params` is missing either field. The NUL separator keeps the two
 *  segments unambiguous — plain concatenation would collide keys like
 *  ("/foo" + "bar/x") with ("/foobar" + "/x"). */
export function getTurnKey(params: unknown): string | undefined {
    if (!params || typeof params !== "object") return undefined;
    const { workspace, sessionId } = params as { workspace?: unknown; sessionId?: unknown };
    if (typeof workspace !== "string" || typeof sessionId !== "string") return undefined;
    return `${workspace}\0${sessionId}`;
}

/**
 * Convert any throwable to RpcResponse.error.
 *
 * Safety contract:
 *   - RpcHandlerError: re-thrown as-is (our own, code/message are safe).
 *   - Any other error: we don't control its message content, so we
 *     sanitise it (truncate to 200 chars, redact long alphanumeric tokens
 *     and UUIDs, prefix with "[upstream] ") and set code = "internal".
 *     This gives users enough to diagnose without becoming a leak channel.
 */
export function normalizeError(id: string, e: unknown): RpcResponse {
    if (e instanceof RpcHandlerError) {
        return err(id, e.code, e.message, e.data);
    }
    // Non-contract error — redact the upstream message.
    const raw = e instanceof Error ? e.message : String(e);
    return err(id, ErrorCodes.Internal, redactUpstreamMessage(raw));
}

/**
 * Truncate + redact sensitive substrings (API keys, UUIDs, etc.).
 * Deliberately conservative: prefer over-redacting to under-redacting.
 */
export function redactUpstreamMessage(raw: string): string {
    if (raw.length === 0) return "[upstream] error";
    // UUID first (sk-ant-api03-abc... unhyphenated keys also match long token regex;
    // 32 hex also matches the long token regex; match the more specific UUID pattern first)
    let s = raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "…uuid");
    // Long alphanumeric tokens (sk-ant-api03-..., gsk-... etc.) replaced with mask
    s = s.replace(/[A-Za-z0-9_-]{20,}/g, "…XXXX");
    // Truncate to 200 chars
    if (s.length > 200) s = `${s.slice(0, 197)}…`;
    return `[upstream] ${s}`;
}
