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
import { createLogger } from "../lib/logger.ts";
import { checkGrantRootSafety } from "../permissions/grantRootSafety.ts";
import {
    chatPolicyKey,
    DEFAULT_IM_WORKSPACE_POLICY,
    IM_POLICY_DOCUMENT_VERSION,
    type ImRoute,
    type ImWorkspacePolicy,
    type ImWorkspacePolicyDocument,
    type ImWorkspacePolicyPatch,
    mergeImWorkspacePolicyPatch,
    migrateLegacyImPolicyDocument,
    normalizePolicyDocument,
    resolveImWorkspacePolicyFromDocument,
    validatePartial,
} from "./imWorkspacePolicy.ts";

const log = createLogger("channel:im-policy-store");

export function imWorkspacePoliciesDir(home: string = tacoHome()): string {
    return path.join(home, "im-workspace-policies");
}

export function imWorkspacePoliciesPath(channelId: string, home: string = tacoHome()): string {
    return path.join(imWorkspacePoliciesDir(home), `${channelId}.json`);
}

function notifiedPath(home: string): string {
    return path.join(imWorkspacePoliciesDir(home), "notified.json");
}

/**
 * A custom execution directory is a grant of the same kind as an associated
 * directory: it BECOMES the IM workspace's root, and that root is what the
 * read/write fence measures against. So it is held to the same rules — no
 * $TACO_HOME (it holds the API keys and the shell permission rules), no
 * filesystem root, no home directory.
 *
 * Checked on the patch, not on the merged document: a directory that was
 * granted before this rule existed (or hand-edited into the file) must not
 * block every later policy write. The runtime refuses it instead — see
 * `resolveImExecutionCwd`.
 */
function assertSafeExecutionDir(patch: ImWorkspacePolicyPatch, source: string): void {
    const dir = patch.executionDir;
    if (dir?.mode !== "custom" || !dir.path) return;
    const verdict = checkGrantRootSafety(dir.path);
    if (!verdict.ok) {
        throw new Error(
            `invalid im policy executionDir.path from ${source}: execution directory ${verdict.reason}`,
        );
    }
}

/**
 * Migrate legacy `binding` / `perChatScratch` layers to `executionDir` as part
 * of a write. Layers that fail validation are kept verbatim: `resolve()`
 * already ignores them, and dropping them on an unrelated write would destroy
 * hand-edited grants without telling anyone.
 */
function migrateDocument(doc: ImWorkspacePolicyDocument): ImWorkspacePolicyDocument {
    const out = normalizePolicyDocument(doc);
    if (doc.default !== undefined && out.default === undefined) out.default = doc.default;
    for (const [key, layer] of Object.entries(doc.chats ?? {})) {
        if (out.chats?.[key] === undefined) out.chats = { ...out.chats, [key]: layer };
    }
    return out;
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
        const source = `channel-default:${channelId}`;
        validatePartial(patch, source);
        assertSafeExecutionDir(patch, source);
        const doc = this.patchDocument(channelId, (d) => {
            const merged = mergeImWorkspacePolicyPatch(d.default ?? {}, patch);
            validatePartial(merged, source);
            return migrateDocument({ ...d, default: merged });
        });
        await this.persist(channelId, doc);
    }

    /** Merge `patch` into this chat's override; omitted fields are preserved. */
    async setChatOverride(route: ImRoute, patch: ImWorkspacePolicyPatch): Promise<void> {
        const source = `chat-override:${route.channelId}`;
        validatePartial(patch, source);
        assertSafeExecutionDir(patch, source);
        const key = chatPolicyKey(route);
        const doc = this.patchDocument(route.channelId, (d) => {
            const merged = mergeImWorkspacePolicyPatch(d.chats?.[key] ?? {}, patch);
            validatePartial(merged, source);
            return migrateDocument({ ...d, chats: { ...(d.chats ?? {}), [key]: merged } });
        });
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
                const doc = parsed as ImWorkspacePolicyDocument;
                if (doc.version !== undefined) return doc;
                // Write the migration back once so the file on disk stops
                // describing the pre-0.2.11 (wider) auto semantics.
                const migrated = migrateLegacyImPolicyDocument(doc);
                this.persist(channelId, migrated).catch((e: unknown) =>
                    log.warn(`im policy migration write-back failed for ${channelId}: ${e}`),
                );
                return migrated;
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
            const stamped = { ...doc, version: IM_POLICY_DOCUMENT_VERSION };
            await fs.promises.writeFile(tmp, `${JSON.stringify(stamped, null, 2)}\n`, {
                mode: 0o600,
            });
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
