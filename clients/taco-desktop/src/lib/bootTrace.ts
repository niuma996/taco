/**
 * Frontend boot-phase trace — the UI half of `src-tauri/src/boot_trace.rs`.
 *
 * The webview console is not persisted, so a slow cold start leaves no
 * frontend evidence once the window is closed. Every mark here is forwarded
 * to the Rust `boot_mark` command, which appends it to
 * `<TACO_HOME>/logs/boot.log` alongside Rust-side marks — one file, one
 * clock, both sides. Deliberately fire-and-forget: a trace call must never
 * delay or fail the boot path it measures (callers don't await; IPC
 * rejections are swallowed).
 */

import { invoke } from "@tauri-apps/api/core";

/** Set false to silence tracing without unpicking the call sites. */
const ENABLED = true;

/**
 * Record a boot phase. Never throws, never blocks.
 *
 * The offset is stamped Rust-side on arrival, so marks share the Rust
 * process-start origin rather than a separate JS epoch. `detail` carries
 * locally-measured durations, which stay accurate regardless of IPC latency.
 */
export function bootMark(label: string, detail?: string): void {
    if (!ENABLED) return;
    void invoke("boot_mark", { label, detail: detail ?? null }).catch(() => {
        /* Tracing must never surface as a boot failure. */
    });
}

/**
 * Time an async phase, emitting `<label>.start` / `<label>.done took=Nms`.
 * Re-throws so control flow is unchanged; the `.done` mark still fires on the
 * failure path, tagged `failed=true`, because a phase that threw after 40s is
 * exactly the signal we are hunting.
 */
export async function bootPhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!ENABLED) return fn();
    bootMark(`${label}.start`);
    const t0 = performance.now();
    try {
        const result = await fn();
        bootMark(`${label}.done`, `took=${Math.round(performance.now() - t0)}ms`);
        return result;
    } catch (err) {
        bootMark(
            `${label}.done`,
            `took=${Math.round(performance.now() - t0)}ms failed=true err=${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        throw err;
    }
}
