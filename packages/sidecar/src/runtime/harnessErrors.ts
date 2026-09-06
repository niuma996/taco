/**
 * Harness error helpers.
 *
 * pi 0.85 replaced the thrown `AgentHarnessError` (which carried a `code`) with
 * two distinct failure channels:
 *
 *   - Expected, actionable failures are RETURNED as `Result.err(TaggedError)`.
 *     `lane.prompt()` resolving with `{ok: false}` is normal control flow.
 *   - Invariant violations are THROWN as `HarnessFault`.
 *
 * Tagged errors are plain `Error` subclasses discriminated by a `_tag` string,
 * NOT by prototype: `new LaneBusy(...) instanceof HarnessFault` is `false`.
 * Identity must be tested with the factory's `.is()` guard (or `_tag`), never
 * with `instanceof HarnessFault`.
 */

import { LaneBusy } from "@earendil-works/pi-agent-core";

/** Any pi tagged error, seen through its discriminant. */
interface TaggedLike {
    readonly _tag?: unknown;
    readonly message?: unknown;
}

/**
 * Convert a returned `Result` error into a throwable `Error`.
 *
 * Tagged errors already extend `Error`, so this mostly annotates them with the
 * operation that produced them — the tag alone ("LaneBusy") does not say which
 * call failed.
 */
export function toHarnessError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
        const tag = (error as TaggedLike)._tag;
        const label = typeof tag === "string" ? tag : error.name;
        const wrapped = new Error(`${operation} failed (${label}): ${error.message}`, {
            cause: error,
        });
        // Preserve the discriminant so downstream guards (isBusyError) still
        // classify the wrapper, not just the original.
        Object.defineProperty(wrapped, "_tag", { value: tag, enumerable: false });
        return wrapped;
    }
    return new Error(`${operation} failed: ${String(error)}`);
}

/**
 * Whether a value represents pi's "lane is already running something" signal.
 *
 * Matches the tagged error, a `toHarnessError` wrapper around it, and the
 * `message === "busy"` shape used by existing test doubles.
 */
export function isBusyError(error: unknown): boolean {
    if (LaneBusy.is(error)) return true;
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as TaggedLike;
    if (candidate._tag === "LaneBusy") return true;
    return candidate.message === "busy";
}
