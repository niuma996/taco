import type { ServerPush } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { isValidChannelId } from "./configValidator.ts";
import type { Channel, ChannelContext, ChannelHandle, ChannelManifest } from "./types.ts";

const log = createLogger("channel");

export interface ChannelConfig {
    /** Runtime-unique id; corresponds to the key in taco.json. Allocated by the registry — channels must not self-report. */
    readonly channelId: string;
    /** Manifest snapshot;used for validation and routing metadata. The Channel instance is created by ChannelFactory. */
    readonly manifest: ChannelManifest;
    readonly config: Record<string, unknown>;
}

interface LoadedChannel {
    channel: Channel;
    handle: ChannelHandle;
    /** Serialized push chain; new pushes append to it and are awaited in stop(). */
    chain: Promise<void>;
}

/** Validates the channelId format on ChannelConfig (static contract, no Channel instance involved; resolved by the factory). */
export function validateChannelInstanceId(cfg: ChannelConfig): string | undefined {
    if (!isValidChannelId(cfg.channelId)) {
        return `invalid channelId: ${cfg.channelId}`;
    }
    return undefined;
}

/** Factory mapping from Config → Channel is inline in loadAndStart. Feishu / WeCom / WeChat-MP in P1. */
export class ChannelRegistry {
    private readonly loaded = new Map<string, LoadedChannel>();
    /** channelId → all im:// workspace keys created by this channel; used to locate workspaces on single-channel restart (P2). */
    private readonly channelWorkspaces = new Map<string, Set<string>>();

    /** Load and start all channel configs. Channel instances are resolved from manifest.name by the resolver; failures are collected in failed, not thrown. */
    async loadAndStart(
        configs: readonly ChannelConfig[],
        resolver: (manifestName: string) => Channel | Promise<Channel>,
        ctxFactory: (channelId: string, config: Record<string, unknown>) => ChannelContext,
    ): Promise<{ started: string[]; failed: { channelId: string; error: string }[] }> {
        const started: string[] = [];
        const failed: { channelId: string; error: string }[] = [];
        for (const cfg of configs) {
            try {
                const validationError = validateChannelInstanceId(cfg);
                if (validationError) throw new Error(validationError);
                const channel = await resolver(cfg.manifest.name);
                const ctx = ctxFactory(cfg.channelId, cfg.config);
                const handle = await channel.start(ctx);
                this.register(cfg.channelId, channel, handle);
                started.push(cfg.channelId);
            } catch (e) {
                failed.push({
                    channelId: cfg.channelId,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return { started, failed };
    }

    /** Register a running channel (channelId allocated by caller/registry, not self-reported). */
    register(channelId: string, channel: Channel, handle: ChannelHandle): void {
        this.loaded.set(channelId, {
            channel,
            handle,
            chain: Promise.resolve(),
        });
    }

    /** Ids of channels currently loaded. Used by per-connection servers to
     *  advertise daemon-level capabilities without re-starting channels. */
    startedIds(): string[] {
        return [...this.loaded.keys()];
    }

    /** Runs a channel's interactive bind flow.
     *  @throws if the channel is unknown or does not support binding. */
    async login(channelId: string, force?: boolean): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) throw new Error(`channel not running: ${channelId}`);
        if (!entry.handle.login) throw new Error(`channel does not support binding: ${channelId}`);
        await entry.handle.login(force);
    }

    /** Discards a channel's credentials. No-op when unbindable. */
    async logout(channelId: string): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) throw new Error(`channel not running: ${channelId}`);
        await entry.handle.logout?.();
    }

    /** Stop and remove a single channel (close handle + clean up its workspace index). */
    async stop(channelId: string): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) return;
        await entry.chain;
        await entry.handle.close();
        this.loaded.delete(channelId);
        this.channelWorkspaces.delete(channelId);
    }

    async stopAll(): Promise<void> {
        for (const id of [...this.loaded.keys()]) {
            await this.stop(id);
        }
    }

    has(channelId: string): boolean {
        return this.loaded.has(channelId);
    }

    /** Record that an im:// workspace belongs to a channel (called by ensureWorkspace on creation). */
    trackWorkspace(channelId: string, imCwd: string): void {
        let set = this.channelWorkspaces.get(channelId);
        if (!set) {
            set = new Set();
            this.channelWorkspaces.set(channelId, set);
        }
        set.add(imCwd);
    }

    /**
     * Remove a single key from the reverse index. Called when a workspace is
     * disposed (invalidateImWorkspaces, channel stop) so the set does not grow
     * monotonically across channel lifetime. Idempotent: removing an absent
     * key is a no-op.
     */
    untrackWorkspace(channelId: string, imCwd: string): void {
        const set = this.channelWorkspaces.get(channelId);
        set?.delete(imCwd);
    }

    /** im:// workspace keys created by this channel — used to invalidate cached
     *  WorkspaceRuntimes after an admin policy change. */
    workspacesForChannel(channelId: string): string[] {
        return [...(this.channelWorkspaces.get(channelId) ?? [])];
    }

    /** Push a frame to a channel. Fire-and-forget — failures are logged to
     *  stderr without breaking the next frame; the per-channel promise chain
     *  preserves push order even if individual handlers are slow. */
    push(channelId: string, frame: ServerPush): void {
        const entry = this.loaded.get(channelId);
        if (!entry) return;
        entry.chain = entry.chain.then(async () => {
            try {
                await entry.handle.push(frame);
            } catch (e) {
                log.child({ channel: channelId, method: frame.method }).error(`push failed: ${e}`);
            }
        });
    }
}
