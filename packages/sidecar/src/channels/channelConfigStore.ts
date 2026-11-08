/**
 * Per-channel persistent state, one JSON file per channelId under
 * `$TACO_HOME/channels/`. Not stored in taco.json's `channels` array because
 * saveGlobalConfig replaces that array wholesale — concurrent writers would
 * clobber each other. Credentials land here plaintext at 0o600 (matching
 * providerKeyStore) and must never cross the RPC boundary unmasked.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { tacoHome } from "../config/tacoHome.ts";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { isValidChannelId } from "./configValidator.ts";
import type { ChannelConfigStore } from "./types.ts";

export function channelStateDir(home: string = tacoHome()): string {
    return path.join(home, "channels");
}

export function channelStatePath(channelId: string, home: string = tacoHome()): string {
    return path.join(channelStateDir(home), `${channelId}.json`);
}

/** Storage key holding a channel's credential blob. Shared, not per-channel:
 *  `channels.list` probes it to answer `configured` without starting the
 *  channel, so the key is part of the store's contract. */
export const CREDENTIALS_KEY = "credentials";
const DELIVERY_BINDING_KEY = "deliveryBinding";

function credentialIdentity(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const fields = value as Record<string, unknown>;
    if (
        typeof fields.accountId === "string" &&
        fields.accountId &&
        typeof fields.baseUrl === "string" &&
        fields.baseUrl
    ) {
        return JSON.stringify(["wechat", fields.accountId, fields.baseUrl]);
    }
    if (typeof fields.botId === "string" && fields.botId) {
        return JSON.stringify(["wecom", fields.botId]);
    }
    return undefined;
}

function sameCredentialIdentity(previous: unknown, next: unknown): boolean {
    const identity = credentialIdentity(previous);
    const nextIdentity = credentialIdentity(next);
    if (identity !== undefined || nextIdentity !== undefined) return identity === nextIdentity;
    // Unknown formats cannot distinguish token refresh from a different account.
    return isDeepStrictEqual(previous, next);
}

/**
 * Whether this channel has credentials on disk. Backs `ChannelStatusEntry.
 * configured`, whose contract is "true once credentials are stored, regardless
 * of current connectivity" — deriving it from the live bind state instead would
 * report false for `error` / `expired`, so the UI could not tell "never bound"
 * from "bound but broken" and would offer Bind where Rebind is correct.
 */
export function hasStoredCredentials(channelId: string, home: string = tacoHome()): boolean {
    try {
        const raw = fs.readFileSync(channelStatePath(channelId, home), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        return (parsed as Record<string, unknown>)[CREDENTIALS_KEY] != null;
    } catch {
        // Missing / unreadable / corrupt file → treat as not configured. A
        // corrupt file also fails the channel's own load, so re-binding is the
        // correct affordance to surface.
        return false;
    }
}

/**
 * Reads the channel's state file, seeded with its taco.json `config` block so a
 * channel can read its own settings. Persisted state wins on key collision —
 * a token written at runtime must not be reverted by a stale config default.
 *
 * Writes are serialized through a promise chain: the read-modify-write cycle
 * awaits, so two concurrent set() calls would otherwise lose the first value.
 */
export class FileChannelConfigStore implements ChannelConfigStore {
    private readonly filePath: string;
    private cache?: Record<string, unknown>;
    private chain: Promise<void> = Promise.resolve();
    private readonly seed: Record<string, unknown>;

    constructor(channelId: string, seed: Record<string, unknown> = {}, home: string = tacoHome()) {
        if (!isValidChannelId(channelId)) {
            throw new Error(`invalid channelId: ${channelId}`);
        }
        this.seed = { ...seed };
        // The store owns generations; config defaults must never restore one.
        delete this.seed[DELIVERY_BINDING_KEY];
        this.filePath = channelStatePath(channelId, home);
    }

    get<T>(name: string): T | undefined {
        return this.load()[name] as T | undefined;
    }

    getDeliveryBinding(): string | undefined {
        const data = this.load();
        const binding = data[DELIVERY_BINDING_KEY];
        return data[CREDENTIALS_KEY] != null && typeof binding === "string" && binding !== ""
            ? binding
            : undefined;
    }

    async ensureDeliveryBinding(): Promise<void> {
        const run = this.chain.then(async () => {
            const current = this.load();
            if (current[CREDENTIALS_KEY] == null || this.getDeliveryBinding()) return;
            const next = { ...current, [DELIVERY_BINDING_KEY]: randomUUID() };
            await this.persist(next);
            this.cache = next;
        });
        this.chain = run.catch(() => {});
        return run;
    }

    async set<T>(name: string, value: T): Promise<void> {
        if (name === DELIVERY_BINDING_KEY)
            throw new Error("delivery binding is managed by the store");
        const run = this.chain.then(async () => {
            const next = { ...this.load() };
            if (value === undefined || (name === CREDENTIALS_KEY && value === null))
                delete next[name];
            else next[name] = value;
            if (name === CREDENTIALS_KEY) {
                if (next[CREDENTIALS_KEY] === undefined) delete next[DELIVERY_BINDING_KEY];
                else if (
                    !this.getDeliveryBinding() ||
                    !sameCredentialIdentity(this.load()[CREDENTIALS_KEY], value)
                ) {
                    next[DELIVERY_BINDING_KEY] = randomUUID();
                }
            }
            await this.persist(next);
            this.cache = next;
        });
        // Keep the chain alive on failure so a rejected write does not poison
        // every subsequent set() on this store.
        this.chain = run.catch(() => {});
        return run;
    }

    /** Drops runtime state and masks any credentials still present in config defaults. */
    async clear(): Promise<void> {
        const run = this.chain.then(async () => {
            const next = { ...this.seed };
            delete next[CREDENTIALS_KEY];
            // A deletion marker masks credentials still present in taco.json defaults.
            if (this.seed[CREDENTIALS_KEY] != null) await this.persist(next);
            else await fs.promises.rm(this.filePath, { force: true });
            this.cache = next;
        });
        this.chain = run.catch(() => {});
        return run;
    }

    private load(): Record<string, unknown> {
        if (this.cache) return this.cache;
        let persisted: Record<string, unknown> = {};
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                persisted = parsed as Record<string, unknown>;
            }
        } catch {
            // Missing or corrupt file falls back to seed-only. A corrupt file is
            // not fatal: the channel re-binds rather than failing to start.
        }
        this.cache = { ...this.seed, ...persisted };
        if (this.cache[CREDENTIALS_KEY] === null) delete this.cache[CREDENTIALS_KEY];
        return this.cache;
    }

    private async persist(data: Record<string, unknown>): Promise<void> {
        const dir = path.dirname(this.filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await restrictOwner(dir, 0o700);
        const tmp = `${this.filePath}.tmp-${process.pid}`;
        const persisted = { ...data };
        if (this.seed[CREDENTIALS_KEY] != null && data[CREDENTIALS_KEY] === undefined) {
            persisted[CREDENTIALS_KEY] = null;
        }
        await fs.promises.writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`);
        await restrictOwner(tmp, 0o600);
        try {
            await fs.promises.rename(tmp, this.filePath);
        } catch (e) {
            await fs.promises.rm(tmp, { force: true });
            throw e;
        }
    }
}
