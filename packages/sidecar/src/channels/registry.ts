import type { ChannelsBindCreds, ImRoute, ServerPush } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { isValidChannelId } from "./configValidator.ts";
import type {
    Channel,
    ChannelContext,
    ChannelHandle,
    ChannelManifest,
    SendOutboundResult,
} from "./types.ts";

const log = createLogger("channel");

/** Superseded interactive binding is normal control flow, not a channel failure. */
export class ChannelBindingCancelled extends Error {
    constructor() {
        super("channel binding was cancelled");
    }
}

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
    bindingEpoch: number;
    bindingChange?: AbortController;
    closing?: boolean;
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
                await ctx.config.ensureDeliveryBinding?.();
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
            bindingEpoch: 0,
        });
    }

    /** Ids of channels currently loaded. Used by per-connection servers to
     *  advertise daemon-level capabilities without re-starting channels. */
    startedIds(): string[] {
        return [...this.loaded.keys()];
    }

    /** Runs a channel's interactive bind flow (or persists `creds` for
     *  channels without a QR flow). @throws if the channel is unknown or
     *  does not support binding. */
    async login(channelId: string, force?: boolean, creds?: ChannelsBindCreds): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) throw new Error(`channel not running: ${channelId}`);
        if (!entry.handle.login) throw new Error(`channel does not support binding: ${channelId}`);
        this.cancelBinding(entry);
        await this.changeBinding(channelId, entry, () => entry.handle.login?.(force, creds));
    }

    /** Discards a channel's credentials. No-op when unbindable. */
    async logout(channelId: string): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) throw new Error(`channel not running: ${channelId}`);
        this.cancelBinding(entry);
        await this.changeBinding(channelId, entry, () => entry.handle.logout?.());
    }

    private async changeBinding(
        channelId: string,
        entry: LoadedChannel,
        change: () => Promise<void> | undefined,
    ): Promise<void> {
        const epoch = entry.bindingEpoch;
        const result = entry.chain.then(async () => {
            if (
                this.loaded.get(channelId) !== entry ||
                entry.closing ||
                epoch !== entry.bindingEpoch
            )
                throw new ChannelBindingCancelled();
            const controller = new AbortController();
            entry.bindingChange = controller;
            let cancelled!: () => void;
            const cancellation = new Promise<never>((_resolve, reject) => {
                cancelled = () => reject(new ChannelBindingCancelled());
                controller.signal.addEventListener("abort", cancelled, { once: true });
            });
            try {
                await Promise.race([change(), cancellation]);
            } finally {
                controller.signal.removeEventListener("abort", cancelled);
                if (entry.bindingChange === controller) entry.bindingChange = undefined;
            }
        });
        entry.chain = result.catch(() => undefined);
        await result;
    }

    private cancelBinding(entry: LoadedChannel): void {
        entry.bindingEpoch++;
        if (!entry.bindingChange) return;
        entry.bindingChange.abort();
        entry.handle.cancelBinding?.();
    }

    getDeliveryBinding(channelId: string): string | undefined {
        const entry = this.loaded.get(channelId);
        return entry?.closing || entry?.bindingChange
            ? undefined
            : entry?.handle.getDeliveryBinding?.();
    }

    /** Reconnect using the channel's already-stored credentials. No-op when
     *  the channel has no such hook (wechat reconnects on its own; mock has
     *  no connection) — a stray retry must not overwrite a channel's real
     *  error state with "does not support retry". Throws only when the
     *  channel is unknown. */
    async retryWithStoredCreds(channelId: string): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) throw new Error(`channel not running: ${channelId}`);
        await entry.handle.retryWithStoredCreds?.();
    }

    /** Stop and remove a single channel (close handle + clean up its workspace index). */
    async stop(channelId: string): Promise<void> {
        const entry = this.loaded.get(channelId);
        if (!entry) return;
        entry.closing = true;
        this.cancelBinding(entry);
        await entry.chain;
        await entry.handle.close();
        if (this.loaded.get(channelId) === entry) this.loaded.delete(channelId);
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

    /**
     * Send one text to a peer and report what the platform said.
     *
     * A channel that is not loaded, or has no outbound path, is `unavailable`:
     * both clear themselves (the channel starts, or is replaced), so the
     * caller should wait rather than count an attempt. Goes through the same
     * per-channel chain as `push`, so a Work notice never interleaves with a
     * streaming reply mid-sentence.
     */
    async sendText(
        channelId: string,
        route: ImRoute,
        text: string,
        expected?: { bindingId: string },
    ): Promise<SendOutboundResult> {
        const entry = this.loaded.get(channelId);
        if (!entry?.handle.sendText) return { kind: "unavailable", code: "channel_unavailable" };
        const send = entry.handle.sendText.bind(entry.handle);
        const result = entry.chain.then(async (): Promise<SendOutboundResult> => {
            if (this.loaded.get(channelId) !== entry || entry.closing)
                return { kind: "unavailable", code: "channel_replaced" };
            if (expected) {
                const binding = entry.handle.getDeliveryBinding?.();
                if (!binding) return { kind: "unavailable", code: "binding_unavailable" };
                if (binding !== expected.bindingId)
                    return { kind: "permanentFailure", code: "binding_changed" };
            }
            try {
                return await send(route, text);
            } catch (e) {
                // A handle that throws instead of returning has told us nothing
                // about whether the platform saw the message. Retryable is the
                // safe reading; the cost is a possible duplicate, never a loss.
                log.child({ channel: channelId }).error(`sendText threw: ${e}`);
                return { kind: "retryable", code: "send_threw" };
            }
        });
        entry.chain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** The channel's per-message cap, or undefined when it is not loaded. */
    maxMessageLength(channelId: string): number | undefined {
        return this.loaded.get(channelId)?.channel.manifest.capabilities.maxMessageLength;
    }

    /** Push a frame to a channel. Fire-and-forget — failures are logged to
     *  stderr without breaking the next frame; the per-channel promise chain
     *  preserves push order even if individual handlers are slow. */
    push(channelId: string, frame: ServerPush): void {
        const entry = this.loaded.get(channelId);
        if (!entry) return;
        const binding = entry.handle.getDeliveryBinding?.();
        entry.chain = entry.chain.then(async () => {
            if (
                this.loaded.get(channelId) !== entry ||
                entry.closing ||
                entry.handle.getDeliveryBinding?.() !== binding
            )
                return;
            try {
                await entry.handle.push(frame);
            } catch (e) {
                log.child({ channel: channelId, method: frame.method }).error(`push failed: ${e}`);
            }
        });
    }
}
