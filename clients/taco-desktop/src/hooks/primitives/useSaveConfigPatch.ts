/**
 * Saves either sidecar global config or local client preferences.
 * The discriminated union prevents mixing the two patch domains. Global writes
 * use settingsWrite and refresh the local cache from the RPC result; client
 * writes use local storage. Exposes saving/error state and clears errors after
 * four seconds.
 *
 * Failure semantics: `save()` re-throws so callers can gate their next steps
 * (UI state updates, sidecar restart) on actual success. The previous
 * implementation swallowed rejections into `error` and resolved normally,
 * which let `McpSection` close the form and restart the sidecar even when
 * disk write had failed.
 *
 * Concurrency: saves are serialised through a pending-promise chain. Two
 * concurrent `save()` calls do not fire two parallel RPCs — the second one
 * waits for the first to settle before issuing its own.
 */

import type { TacoGlobalConfigShape } from "@taco-ai/protocol";
import { useCallback, useRef, useState } from "react";
import type { TacoClientSettingsShape } from "../../lib/clientSettings.ts";
import { applyGlobalConfig, writeClientSettings } from "../../lib/globalConfig.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";

export type SavePatchInput =
    | { kind: "global"; patch: Partial<TacoGlobalConfigShape> }
    | { kind: "client"; patch: Partial<TacoClientSettingsShape> };

export interface SaveConfigPatchApi {
    save: (input: SavePatchInput) => Promise<void>;
    saving: boolean;
    error: string | null;
}

const ERROR_TIMEOUT_MS = 4000;

export function useSaveConfigPatch(client: TacoClient): SaveConfigPatchApi {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Pending-promise chain serialises saves. Errors must not break the chain
    // so a failed save doesn't poison the next attempt; we drop the failure
    // from the chain by `.then(undefined, () => undefined)` below.
    const pendingRef = useRef<Promise<void>>(Promise.resolve());
    // Single active error-clear timer — a stale timer firing after a fresh
    // save would clear a new error, so each new failure supersedes the
    // previous timer.
    const errorTimerRef = useRef<number | undefined>(undefined);

    const run = useCallback(
        (next: SavePatchInput): Promise<void> => {
            const work = async (): Promise<void> => {
                setSaving(true);
                setError(null);
                if (errorTimerRef.current !== undefined) {
                    window.clearTimeout(errorTimerRef.current);
                    errorTimerRef.current = undefined;
                }
                try {
                    if (next.kind === "global") {
                        const result = await client.settingsWrite({ global: next.patch });
                        applyGlobalConfig(result.global);
                    } else {
                        await writeClientSettings(next.patch);
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    setError(msg);
                    if (errorTimerRef.current !== undefined) {
                        window.clearTimeout(errorTimerRef.current);
                    }
                    errorTimerRef.current = window.setTimeout(() => {
                        setError(null);
                        errorTimerRef.current = undefined;
                    }, ERROR_TIMEOUT_MS);
                    // Rethrow so the caller can gate its UI / restart on
                    // success — see McpSection.handleSave.
                    throw e instanceof Error ? e : new Error(msg);
                } finally {
                    setSaving(false);
                }
            };
            // Errors must not break the chain so subsequent calls still execute.
            const next$ = pendingRef.current.then(
                () => work(),
                () => work(),
            );
            pendingRef.current = next$.then(
                () => undefined,
                () => undefined,
            );
            return next$;
        },
        [client],
    );

    return { save: run, saving, error };
}
