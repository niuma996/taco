/**
 * Harness context helpers.
 *
 * pi 0.85 threads a `Context` (from `@earendil-works/chord`) through every
 * harness, lane and session call. It carries cancellation and telemetry
 * parentage; it is NOT a place to stash application state.
 *
 * The sidecar has no ambient request context of its own, so we use pi's
 * process-lifetime root (`BACKGROUND_CONTEXT`) as the base and derive a
 * cancellable child wherever a caller already owns an `AbortSignal`.
 *
 * Why a module instead of inlining `BACKGROUND_CONTEXT` at each call site:
 * when the sidecar grows a real per-request context, only this file changes.
 */

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core";

/**
 * Root context for harness/session work that outlives any single RPC.
 *
 * Session attach, lane acquisition, tool registration and shutdown all use
 * this — they are daemon-lifetime operations with no caller to cancel them.
 */
export const harnessContext: Context = BACKGROUND_CONTEXT;

/**
 * Derive a cancellable context from an optional caller signal.
 *
 * Returns the root context unchanged when the caller has no signal, so
 * callers can pass `signal?: AbortSignal` straight through.
 */
export function contextFor(signal: AbortSignal | undefined): Context {
    return signal === undefined ? harnessContext : withAbortSignal(signal, harnessContext);
}
