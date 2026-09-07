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

/** The subset of pi's OperationResultRecord that describes a non-success run. */
interface TerminalOutcome {
    readonly status: string;
    readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Convert a non-`completed` operation record into a throwable `Error`.
 *
 * A run can reach a terminal state without producing a reply — the model is
 * unavailable, a hook declined, the turn was aborted. pi records why in
 * `record.error` ({code, message}); that field is the ONLY place the reason
 * exists, since the run itself resolved `ok: true` (reaching a terminal state is
 * not a call failure). Dropping it leaves callers guessing from a downstream
 * symptom — "expected an assistant reply, got role=user" instead of
 * "model_unavailable".
 *
 * The `code` is carried on the returned error so RPC layers can map it, and the
 * status is always included: `aborted` with no `error` is a normal outcome that
 * still needs to be distinguishable from a failure.
 */
export function toTerminalError(operation: string, outcome: TerminalOutcome): Error {
    const code = outcome.error?.code;
    const detail = outcome.error?.message;
    const label = code ? `${outcome.status}/${code}` : outcome.status;
    const error = new Error(detail ? `${operation} ${label}: ${detail}` : `${operation} ${label}`);
    if (code !== undefined) {
        Object.defineProperty(error, "code", { value: code, enumerable: false });
    }
    return error;
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
