/**
 * IM channel control surface — the `channels.*` RPC contract plus the
 * config/broker → wire-entry mapping the status push shares with it.
 *
 * Split out of `SidecarServer` because none of it touches transport, dispatch
 * or the workspace map: it reads the channel registry / bind broker /
 * conversation router and the configured-instance list, then reports. The
 * push fan-out stays on `SidecarServer`, since that iterates workspaces.
 */

import type {
    ChannelInstanceConfig,
    ChannelStatusEntry,
    ChannelsBindCreds,
    ChannelsBindResult,
    ChannelsCreateResult,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ChannelsRetryResult,
} from "@taco-ai/protocol";
import { BUILTIN_CHANNEL_MANIFESTS } from "../channels/builtinManifests.ts";
import type { ChannelBindBroker, ChannelBindStatus } from "../channels/channelBindBroker.ts";
import { hasStoredCredentials } from "../channels/channelConfigStore.ts";
import { isValidChannelId } from "../channels/configValidator.ts";
import type { ConversationRouter } from "../channels/conversationRouter.ts";
import type { ChannelConfig, ChannelRegistry } from "../channels/registry.ts";
import { readGlobalConfig, saveGlobalConfig } from "../config/config.ts";
import { createLogger } from "../lib/logger.ts";
import type { ChannelControl } from "../runtime/serverRpcSurface.ts";
import type { ImChannelContext } from "../tags/index.ts";

const log = createLogger("sidecar.channelControl");

export interface ChannelControlDeps {
    /** Always present — `SidecarServer` defaults it in its constructor. */
    readonly channelRegistry: ChannelRegistry;
    readonly channelBindBroker: ChannelBindBroker;
    /**
     * Unset until `start()` loads (or accepts an injected) router — a getter,
     * so the surface sees the live value rather than the constructor's.
     */
    readonly getConversationRouter: () => ConversationRouter | undefined;
    /** Assigned by `start()`. A getter for the same reason. */
    readonly getChannelConfigs: () => readonly ChannelConfig[];
    /** Instances whose boot-time loadAndStart failed; surfaced in `channels.list`. */
    readonly getFailedChannels: () => readonly { channelId: string; error: string }[];
}

export interface ChannelControlSurface {
    readonly channels: ChannelControl;
    readConfiguredChannels(): ChannelInstanceConfig[];
    toStatusEntry(
        status: ChannelBindStatus,
        cfg?: { manifest: { name: string } },
    ): ChannelStatusEntry;
    resolveImChannel(channelId: string): ImChannelContext | undefined;
}

/** Reports a fire-and-forget bind/retry failure into the broker's error state. */
function failChannel(
    deps: ChannelControlDeps,
    channelId: string,
    verb: string,
    error: unknown,
): void {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`channel ${channelId} ${verb} failed: ${message}`);
    deps.channelBindBroker.setState(channelId, "error", { message });
}

export function createChannelControl(deps: ChannelControlDeps): ChannelControlSurface {
    /**
     * Union of in-memory `channelConfigs` (start-time snapshot) with anything
     * written to taco.json since. Used by both `channels.list` and
     * `channels.create` so they can't disagree about what exists — the bug
     * they were diverging on surfaced as "channel already exists" without the
     * UI seeing the new entry.
     *
     * Disk is authoritative; the in-memory record wins on `config` so a
     * settings.write mutation made after startup isn't clobbered.
     *
     * Returns the wire (`ChannelInstanceConfig`) shape rather than the richer
     * runtime `ChannelConfig`, since only the on-disk fields reach the wire.
     */
    function readConfiguredChannels(): ChannelInstanceConfig[] {
        const configs = deps.getChannelConfigs();
        const onDisk = readGlobalConfig().channels ?? [];
        const byId = new Map(configs.map((c) => [c.channelId, c]));
        const merged: ChannelInstanceConfig[] = [];
        const seen = new Set<string>();
        for (const cfg of onDisk) {
            const live = byId.get(cfg.channelId);
            seen.add(cfg.channelId);
            merged.push(
                live
                    ? { channelId: cfg.channelId, manifest: cfg.manifest, config: live.config }
                    : cfg,
            );
        }
        for (const cfg of configs) {
            if (!seen.has(cfg.channelId)) {
                merged.push({
                    channelId: cfg.channelId,
                    manifest: cfg.manifest,
                    config: cfg.config,
                });
            }
        }
        return merged;
    }

    /**
     * Broker frames carry only the transition fields (channelId/state/QR/...).
     * The wire entry also needs the config-derived name and the on-disk
     * configured flag, so the push payload matches `channels.list` output and
     * the client's wholesale entry replacement stays consistent.
     */
    function toStatusEntry(
        status: ChannelBindStatus,
        cfg?: { manifest: { name: string } },
    ): ChannelStatusEntry {
        const config =
            cfg ?? deps.getChannelConfigs().find((c) => c.channelId === status.channelId);
        return {
            channelId: status.channelId,
            name: config?.manifest.name ?? status.channelId,
            state: status.state,
            // Probed from disk, not derived from state: the contract is
            // "credentials are stored, regardless of connectivity", so an
            // errored/expired binding still reports true and the UI offers
            // Rebind instead of Bind.
            configured: hasStoredCredentials(status.channelId),
            qrUrl: status.qrUrl,
            requestId: status.requestId,
            retry: status.retry,
            message: status.message,
        };
    }

    const channels: ChannelControl = {
        list: (): ChannelsListResult => {
            const configured = readConfiguredChannels();
            return {
                available: BUILTIN_CHANNEL_MANIFESTS.map((m) => ({
                    name: m.name,
                    version: m.version,
                    description: m.description,
                    maxMessageLength: m.capabilities.maxMessageLength,
                    requiresPersistentProcess: m.capabilities.requiresPersistentProcess ?? false,
                    approvalButton: m.capabilities.approvalButton ?? false,
                })),
                configured: configured.map((cfg) =>
                    toStatusEntry(deps.channelBindBroker.status(cfg.channelId), cfg),
                ),
                failed: [...deps.getFailedChannels()],
            };
        },
        // conversationRouter may be unset before start() finishes; treat that
        // as "no conversations yet" rather than throwing — listConversations
        // is a process-level query, not a precondition for IM to function.
        listConversations: (channelId): ChannelsListConversationsResult => ({
            conversations: deps.getConversationRouter()?.listAll(channelId) ?? [],
        }),
        create: (name, channelId): ChannelsCreateResult => {
            const manifest = BUILTIN_CHANNEL_MANIFESTS.find((m) => m.name === name);
            if (!manifest) throw new Error(`unknown channel type: ${name}`);
            const id = channelId ?? name;
            if (!isValidChannelId(id)) throw new Error(`invalid channelId: ${id}`);

            // Merge disk and in-memory: another writer may have added an
            // instance since startup, and `channels.list` reads through this
            // same helper so the two paths can't disagree about what exists.
            const existing = readConfiguredChannels();
            if (existing.some((c) => c.channelId === id)) {
                throw new Error(`channelId already exists: ${id}`);
            }
            saveGlobalConfig({
                channels: [
                    ...existing,
                    {
                        channelId: id,
                        manifest: {
                            name: manifest.name,
                            version: manifest.version,
                        },
                        config: {},
                    },
                ],
            });
            // Channels load statically at startup (same as extensions), so the
            // new instance is not bindable until the sidecar restarts.
            return { channelId: id, requiresRestart: true };
        },
        bind: async (
            channelId: string,
            force?: boolean,
            creds?: ChannelsBindCreds,
        ): Promise<ChannelsBindResult> => {
            const cfg = deps.getChannelConfigs().find((c) => c.channelId === channelId);
            if (!cfg) throw new Error(`unknown channelId: ${channelId}`);
            if (!deps.channelRegistry.has(channelId)) {
                throw new Error(`channel ${channelId} is not running`);
            }
            // Login is deliberately not awaited: the QR flow needs many
            // seconds of human interaction, and progress is reported through
            // `channel.status_changed` pushes instead. The wecom channel uses
            // the same fire-and-forget path; the awaited surface just kicks
            // a (creds → store → connect) sequence in the background.
            void deps.channelRegistry.login(channelId, force, creds).catch((e: unknown) => {
                failChannel(deps, channelId, "bind", e);
            });
            return { channelId, state: deps.channelBindBroker.status(channelId).state };
        },
        submitVerifyCode: (requestId, code) =>
            deps.channelBindBroker.submitVerifyCode(requestId, code),
        unbind: async (channelId) => {
            if (!deps.getChannelConfigs().some((c) => c.channelId === channelId)) {
                throw new Error(`unknown channelId: ${channelId}`);
            }
            await deps.channelRegistry.logout(channelId);
            deps.channelBindBroker.reset(channelId);
        },
        retry: async (channelId): Promise<ChannelsRetryResult> => {
            const cfg = deps.getChannelConfigs().find((c) => c.channelId === channelId);
            if (!cfg) throw new Error(`unknown channelId: ${channelId}`);
            if (!deps.channelRegistry.has(channelId)) {
                throw new Error(`channel ${channelId} is not running`);
            }
            // Fire-and-forget for the same reason as `bind`: reconnect kicks
            // the SDK's WS retry cycle, and progress arrives through
            // channel.status_changed pushes. Errors land in the broker's error
            // state for the UI to surface.
            void deps.channelRegistry.retryWithStoredCreds(channelId).catch((e: unknown) => {
                failChannel(deps, channelId, "retry", e);
            });
            // For wecom, reconnect() sets "connecting" synchronously before the
            // void promise is scheduled, so this status is already the new one;
            // for no-op channels it reports the current state. Either way the
            // caller should not treat it as authoritative — follow the push.
            return { channelId, state: deps.channelBindBroker.status(channelId).state };
        },
    };

    /**
     * Resolve a configured channel instance id to its safe IM channel identity
     * for the `<im_channel>` context tag. Deliberately minimal — only platform
     * type (manifest name) + instance id. No bind state, no configuration
     * contents, no credentials, no peer/chat identifiers. Unknown ids → undefined.
     */
    function resolveImChannel(channelId: string): ImChannelContext | undefined {
        const cfg = deps.getChannelConfigs().find((c) => c.channelId === channelId);
        if (!cfg) return undefined;
        return { type: cfg.manifest.name, channelId: cfg.channelId };
    }

    return { channels, readConfiguredChannels, toStatusEntry, resolveImChannel };
}
