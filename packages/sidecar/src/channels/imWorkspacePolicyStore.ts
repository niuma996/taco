/**
 * Persistent store for IM workspace policies.
 *
 * Lives at `$TACO_HOME/im-workspace-policies/<channelId>.json` — deliberately
 * NOT inside ChannelConfigStore, because WeChat logout() calls
 * ctx.config.clear() which wipes that file's entire contents. Admin-granted
 * policy must survive unbind / rebind cycles.
 *
 * WARNING for callers of the mutating methods: `SidecarServer.ensureWorkspace`
 * caches WorkspaceRuntimes, so a policy write has no effect on an already
 * constructed workspace. The server must invalidate the affected im://
 * workspaces after a successful write (see policyInvalidation in server.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tacoHome } from "../config/tacoHome.ts";
import { restrictOwner } from "../lib/fsPermissions.ts";
import {
    chatPolicyKey,
    DEFAULT_IM_WORKSPACE_POLICY,
    type ImRoute,
    type ImWorkspacePolicy,
    type ImWorkspacePolicyDocument,
    type ImWorkspacePolicyPatch,
    mergeImWorkspacePolicyPatch,
    resolveImWorkspacePolicyFromDocument,
    validatePartial,
} from "./imWorkspacePolicy.ts";

export function imWorkspacePoliciesDir(home: string = tacoHome()): string {
    return path.join(home, "im-workspace-policies");
}

export function imWorkspacePoliciesPath(channelId: string, home: string = tacoHome()): string {
    return path.join(imWorkspacePoliciesDir(home), `${channelId}.json`);
}

function notifiedPath(home: string): string {
    return path.join(imWorkspacePoliciesDir(home), "notified.json");
}

export class ImWorkspacePolicyStore {
    private readonly home: string;
    private readonly policiesDir: string;
    private readonly notifiedFile: string;
    private readonly notified = new Set<string>();
    private chain: Promise<void> = Promise.resolve();

    constructor(home: string = tacoHome()) {
        this.home = home;
        this.policiesDir = imWorkspacePoliciesDir(home);
        this.notifiedFile = notifiedPath(home);
        this.loadNotified();
    }

    /** Synchronous resolution — reads the in-memory cache. Fail-closed. */
    resolve(route: ImRoute): ImWorkspacePolicy {
        const doc = this.loadDocument(route.channelId);
        return resolveImWorkspacePolicyFromDocument(doc, route);
    }

    /**
     * Public raw read of the channel's policy document ({} when absent).
     * Deliberately uncached — matches `resolve()`'s contract so hand-edited
     * JSON is visible on the next call without restart. The admin RPC
     * `imPolicy.get` uses this to render the editor.
     */
    readDocument(channelId: string): ImWorkspacePolicyDocument {
        return this.loadDocument(channelId) ?? {};
    }

    /**
     * Merge `patch` into the channel default. Fields the patch omits are
     * preserved — editing perChatScratch must not silently revoke an existing
     * shell grant.
     */
    async setChannelDefault(channelId: string, patch: ImWorkspacePolicyPatch): Promise<void> {
        validatePartial(patch, `channel-default:${channelId}`);
        const doc = this.patchDocument(channelId, (d) => ({
            ...d,
            default: mergeImWorkspacePolicyPatch(d.default ?? {}, patch),
        }));
        await this.persist(channelId, doc);
    }

    /** Merge `patch` into this chat's override; omitted fields are preserved. */
    async setChatOverride(route: ImRoute, patch: ImWorkspacePolicyPatch): Promise<void> {
        validatePartial(patch, `chat-override:${route.channelId}`);
        const key = chatPolicyKey(route);
        const doc = this.patchDocument(route.channelId, (d) => ({
            ...d,
            chats: {
                ...(d.chats ?? {}),
                [key]: mergeImWorkspacePolicyPatch(d.chats?.[key] ?? {}, patch),
            },
        }));
        await this.persist(route.channelId, doc);
    }

    async clearChatOverride(route: ImRoute): Promise<void> {
        const key = chatPolicyKey(route);
        await this.clearChatOverrideByKey(route.channelId, key);
    }

    /**
     * Drop a chat override by its raw chats-map key. Needed when clearing an
     * orphan override — the conversation that owned the key is no longer
     * routed, so the (peerId, chatId) route cannot be reconstructed from
     * the sha256 alone. No-op if the key is absent (avoid touching disk
     * for stale writes), but never throws.
     */
    async clearChatOverrideByKey(channelId: string, key: string): Promise<void> {
        const doc = this.patchDocument(channelId, (d) => {
            const chats = { ...(d.chats ?? {}) };
            delete chats[key];
            return { ...d, chats };
        });
        await this.persist(channelId, doc);
    }

    hasNotified(workspaceKey: string): boolean {
        return this.notified.has(workspaceKey);
    }

    async markNotified(workspaceKey: string): Promise<void> {
        if (this.notified.has(workspaceKey)) return;
        this.notified.add(workspaceKey);
        await this.persistNotified();
    }

    /**
     * Read the channel's policy document from disk on every call — deliberately
     * uncached.
     *
     * `resolve()` is only reached from `ensureWorkspace`'s cache-miss branch, so
     * this runs once per workspace lifetime: a cold path where one small file
     * read costs nothing. An in-memory cache here would instead be actively
     * harmful, because editing the JSON by hand is currently the only way to
     * configure a policy, and a cached document would ignore that edit until
     * the sidecar restarted.
     */
    private loadDocument(channelId: string): ImWorkspacePolicyDocument | undefined {
        try {
            const raw = fs.readFileSync(imWorkspacePoliciesPath(channelId, this.home), "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as ImWorkspacePolicyDocument;
            }
        } catch {
            // Missing or corrupt file resolves to defaults — never fatal.
        }
        return undefined;
    }

    private patchDocument(
        channelId: string,
        mutate: (d: ImWorkspacePolicyDocument) => ImWorkspacePolicyDocument,
    ): ImWorkspacePolicyDocument {
        const current = this.loadDocument(channelId) ?? {};
        return mutate(current);
    }

    private persist(channelId: string, doc: ImWorkspacePolicyDocument): Promise<void> {
        const run = this.chain.then(async () => {
            const filePath = imWorkspacePoliciesPath(channelId, this.home);
            await fs.promises.mkdir(this.policiesDir, { recursive: true, mode: 0o700 });
            const tmp = `${filePath}.tmp-${process.pid}`;
            await fs.promises.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
            try {
                await fs.promises.rename(tmp, filePath);
            } catch (e) {
                await fs.promises.rm(tmp, { force: true });
                throw e;
            }
        });
        this.chain = run.catch(() => {});
        return run;
    }

    private loadNotified(): void {
        try {
            const raw = fs.readFileSync(this.notifiedFile, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                const keys = Object.keys(parsed as Record<string, unknown>);
                for (const k of keys) this.notified.add(k);
            }
        } catch {
            // Absent / corrupt notified.json → treat as nothing notified yet.
        }
    }

    private persistNotified(): Promise<void> {
        const run = this.chain.then(async () => {
            const data: Record<string, true> = {};
            for (const k of this.notified) data[k] = true;
            await fs.promises.mkdir(this.policiesDir, { recursive: true });
            await restrictOwner(this.policiesDir, 0o700);
            const tmp = `${this.notifiedFile}.tmp-${process.pid}`;
            await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
            await restrictOwner(tmp, 0o600);
            try {
                await fs.promises.rename(tmp, this.notifiedFile);
            } catch (e) {
                await fs.promises.rm(tmp, { force: true });
                throw e;
            }
        });
        this.chain = run.catch(() => {});
        return run;
    }
}

// Re-exported for callers that validate a patch before persisting.
export { DEFAULT_IM_WORKSPACE_POLICY };
