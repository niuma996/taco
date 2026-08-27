/**
 * ProviderKeyStore — process-wide in-memory apiKeys + pi CredentialStore.
 * Gives sidecar a hot-updatable snapshot (no restart after settings.write).
 * Keys mirrored to process.env so subprocesses that read *_API_KEY see the latest value.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { injectApiKeysToEnv } from "../config/config.ts";

/**
 * Process-wide record of `*_API_KEY` env vars this class injected.
 * `process.env` is process-global, so the record is too — shell tools read it
 * to scrub provider keys from the environment they hand to model-run commands.
 *
 * syncToEnv only clears stale env keys that this class itself wrote — external
 * shell-injected `*_API_KEY` values (not written by us) are never deleted.
 * Without this, an empty apiKeys at startup would let syncToEnv wipe derived
 * env keys like shell-set GOOGLE_API_KEY, violating the "credential → env"
 * spirit of pi's resolution order.
 */
const injectedEnvKeys = new Set<string>();

/** Whether `key` names an env var ProviderKeyStore injected (not the user's own). */
export function isInjectedEnvKey(key: string): boolean {
    return injectedEnvKeys.has(key);
}

export class ProviderKeyStore implements CredentialStore {
    private apiKeys: Record<string, string>;
    /** Per-provider promise chain, satisfying CredentialStore.modify's serialization contract. */
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(initialApiKeys: Record<string, string> = {}) {
        this.apiKeys = { ...initialApiKeys };
        this.syncToEnv();
    }

    // ── existing API (ModelRegistry / settings handler) ──

    /** Check whether a provider has a non-empty key. */
    has(provider: string): boolean {
        return Boolean(this.apiKeys[provider]);
    }

    /** Read a provider's raw key; internal/test only — handlers must use the settings RPC. */
    get(provider: string): string | undefined {
        return this.apiKeys[provider];
    }

    /**
     * Shallow-merge patch into internal state → sync process.env.
     * Keys present in patch override; absent keys are preserved; `""` or
     * `undefined` in patch deletes. No catalog notification needed — catalog
     * is fully resident; pi reads the new key lazily on the next request.
     */
    update(patch: Partial<Record<string, string>>): void {
        const next: Record<string, string> = { ...this.apiKeys };
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === "") {
                delete next[k];
            } else {
                next[k] = v;
            }
        }
        this.apiKeys = next;
        this.syncToEnv();
    }

    // ── pi CredentialStore contract ──

    /** pi reads credentials by provider id. Returns an api_key Credential or undefined. */
    async read(providerId: string): Promise<Credential | undefined> {
        const key = this.apiKeys[providerId];
        if (!key) return undefined;
        return { type: "api_key", key };
    }

    /** List configured provider ids + type (does not leak secrets). */
    async list(): Promise<readonly CredentialInfo[]> {
        return Object.entries(this.apiKeys)
            .filter(([, v]) => Boolean(v))
            .map(([providerId]) => ({ providerId, type: "api_key" as const }));
    }

    /**
     * Serialized write path (CredentialStore contract). Queues by provider id;
     * fn sees the current value and returns the new credential (undefined
     * means no change). On completion syncs internal map + env.
     */
    async modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
        const prev = this.chains.get(providerId) ?? Promise.resolve();
        const run = prev
            .catch(() => {})
            .then(async () => {
                const current = await this.read(providerId);
                const nextCred = await fn(current);
                if (nextCred === undefined) return current;
                const key = nextCred.type === "api_key" ? (nextCred.key ?? "") : "";
                this.update({ [providerId]: key });
                return nextCred;
            });
        // Chain tail: swallow completion (prevent rejection propagation) and
        // finally clean up entries to prevent Map growth. === check ensures we
        // only clear our own chain — a later modify that already overwrote
        // the entry must not be wiped.
        const entry = run.then(
            () => undefined,
            () => undefined,
        );
        this.chains.set(providerId, entry);
        entry.finally(() => {
            if (this.chains.get(providerId) === entry) this.chains.delete(providerId);
        });
        return run;
    }

    /** Delete a provider's credential (logout). Serialized with modify. */
    async delete(providerId: string): Promise<void> {
        await this.modify(providerId, async () => undefined).catch(() => {});
        this.update({ [providerId]: "" });
    }

    /** Mirrors apiKeys into process.env for subprocess callers; only clears keys this class injected. */
    private syncToEnv(): void {
        const patch = injectApiKeysToEnv(this.apiKeys);
        for (const k of Object.keys(process.env)) {
            if (injectedEnvKeys.has(k) && !patch[k] && k.endsWith("_API_KEY")) {
                delete process.env[k];
                injectedEnvKeys.delete(k);
            }
        }
        for (const k of Object.keys(patch)) {
            if (patch[k]) {
                process.env[k] = patch[k];
                injectedEnvKeys.add(k);
            }
        }
    }
}
