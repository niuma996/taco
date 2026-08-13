/**
 * TacoClientBase — shared base class for the Tauri and Node TacoClient.
 *
 * Centralises invariant logic (dispatcher, typed RPC injection, onPush / onWarning,
 * rejectAllPending on dispose). Subclasses implement `makeDispatch()` and
 * `start` / `dispose`; their `call` / `callProcess` are optional.
 *
 * The 20 typed methods are merged via namesake interface — removable if
 * methods are generated or inlined in the future.
 */

import type { ServerPush } from "@taco-ai/protocol";
import { FrameDispatcher, NdjsonLineBuffer } from "./dispatcher.js";
import { createTypedRpc, type RpcDispatch, type TypedRpc } from "./typedRpc.js";

export interface TacoClientBase extends TypedRpc {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: see interface comment above
export abstract class TacoClientBase {
    protected readonly dispatcher = new FrameDispatcher();
    protected readonly buffer = new NdjsonLineBuffer((raw) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            this.onBadLine?.(raw);
            return;
        }
        this.dispatcher.handleFrame(parsed);
    });

    constructor() {
        // Inject the 20 typed methods. The adapter that re-orders args (method, workspace, params) is supplied by the subclass.
        // Runs during super(): subclass fields are NOT yet assigned, so makeDispatch() must not touch them.
        Object.assign(this, createTypedRpc(this.makeDispatch()));
    }

    /**
     * Called for each NDJSON line that fails to JSON.parse. Base is silent;
     * subclasses override to surface the bad frame (Node emits "warn"; the
     * Tauri client leaves it silent).
     */
    protected onBadLine?(raw: string): void;

    /** Subclass hook: route `RpcDispatch.call` / `callProcess` to its transport. */
    protected abstract makeDispatch(): RpcDispatch;

    /** Push-event subscription — public API, forwarded to the dispatcher. */
    onPush(handler: (p: ServerPush) => void): () => void {
        return this.dispatcher.onPush(handler);
    }

    /** Frame-parse warning subscription — public API, forwarded to the dispatcher. */
    onWarning(handler: (info: unknown) => void): () => void {
        return this.dispatcher.onWarning(handler);
    }

    /** Called on dispose; rejects every in-flight request. */
    protected rejectAllPending(reason: Error): void {
        this.dispatcher.rejectAllPending(reason);
    }

    /** Called by transports that own per-workspace sidecar processes. */
    protected rejectWorkspacePending(workspace: string, reason: Error): void {
        this.dispatcher.rejectWorkspacePending(workspace, reason);
    }
}
