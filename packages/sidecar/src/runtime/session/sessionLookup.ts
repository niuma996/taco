/**
 * Session id resolution — "exact id, or the unique session whose id starts
 * with this prefix". Split out of `SessionRegistry` because both the registry
 * and the `session.snapshot.get` handler need it, and a caller should not have
 * to import a stateful component to reach a pure list search.
 */

import type { SessionId } from "@taco-ai/protocol";
import type { JsonlSessionMetadata } from "../pi/types.ts";

export type SessionPrefixResolution =
    | { kind: "found"; meta: JsonlSessionMetadata }
    | { kind: "not_found" }
    | { kind: "ambiguous"; matches: JsonlSessionMetadata[] };

/**
 * Resolve a session id or id prefix against a metadata list. Shared by
 * `SessionRegistry.openSession` and the `session.snapshot.get` handler, which
 * both accept "exact id, or the unique session whose id starts with this
 * prefix". Prefix acceptance dates to the initial commit; no in-tree caller
 * relies on it (the desktop truncates ids for display only and always sends
 * the full id back), so it is kept for out-of-tree and hand-issued RPCs
 * rather than for a known contract.
 *
 * An exact match always wins over a same-prefix collision — a naive
 * `list.find(m => m.id === id || m.id.startsWith(id))` returns whichever
 * candidate appears first, so an exact match can be shadowed by an unrelated
 * session whose id happens to start with it. Two or more *prefix* matches
 * (with no exact match) are reported as ambiguous rather than silently
 * picking one: uuidv7 puts the millisecond timestamp in the leading hex
 * digits, so sessions created in the same window share a short prefix and
 * "first match wins" would routinely open the wrong session. The caller
 * decides whether ambiguity is a hard error or a lenient fallback.
 */
export function resolveSessionByPrefix(
    list: readonly JsonlSessionMetadata[],
    sessionId: SessionId,
): SessionPrefixResolution {
    const exact = list.find((m) => m.id === sessionId);
    if (exact) return { kind: "found", meta: exact };
    const matches = list.filter((m) => m.id.startsWith(sessionId));
    if (matches.length === 0) return { kind: "not_found" };
    if (matches.length > 1) return { kind: "ambiguous", matches };
    return { kind: "found", meta: matches[0] };
}
