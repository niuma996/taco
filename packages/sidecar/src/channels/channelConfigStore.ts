/**
 * Per-channel persistent state, one JSON file per channelId under
 * `$TACO_HOME/channels/`. Not stored in taco.json's `channels` array because
 * saveGlobalConfig replaces that array wholesale — concurrent writers would
 * clobber each other. Credentials land here plaintext at 0o600 (matching
 * providerKeyStore) and must never cross the RPC boundary unmasked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
        return (parsed as Record<string, unknown>)[CREDENTIALS_KEY] !== undefined;
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

    constructor(
        channelId: string,
        private readonly seed: Record<string, unknown> = {},
        home: string = tacoHome(),
    ) {
        if (!isValidChannelId(channelId)) {
            throw new Error(`invalid channelId: ${channelId}`);
        }
        this.filePath = channelStatePath(channelId, home);
    }

    get<T>(name: string): T | undefined {
        return this.load()[name] as T | undefined;
    }

    async set<T>(name: string, value: T): Promise<void> {
        const run = this.chain.then(async () => {
            const next = { ...this.load() };
            if (value === undefined) delete next[name];
            else next[name] = value;
            await this.persist(next);
            this.cache = next;
        });
        // Keep the chain alive on failure so a rejected write does not poison
        // every subsequent set() on this store.
        this.chain = run.catch(() => {});
        return run;
    }

    /** Removes the state file — used by unbind to drop credentials. */
    async clear(): Promise<void> {
        const run = this.chain.then(async () => {
            await fs.promises.rm(this.filePath, { force: true });
            this.cache = { ...this.seed };
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
        return this.cache;
    }

    private async persist(data: Record<string, unknown>): Promise<void> {
        const dir = path.dirname(this.filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await restrictOwner(dir, 0o700);
        const tmp = `${this.filePath}.tmp-${process.pid}`;
        await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
        await restrictOwner(tmp, 0o600);
        try {
            await fs.promises.rename(tmp, this.filePath);
        } catch (e) {
            await fs.promises.rm(tmp, { force: true });
            throw e;
        }
    }
}
