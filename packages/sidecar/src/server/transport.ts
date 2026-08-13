import type { RpcResponse, ServerPush } from "@taco-ai/protocol";

/**
 * Any NDJSON frame sent server → client: push event or RPC response.
 */
export type ServerFrame = ServerPush | RpcResponse;

/**
 * Sidecar ↔ IDE stdio byte-stream channel.
 * NOT the same as Channel (§3.0 design doc): IM ingress owns its own transport;
 * inbound arrives via ctx.ingress.submit() → dispatchRpc, and outbound uses
 * emitPush with workspace-based routing.
 */
export interface Transport {
    /** Start inbound listener. send() is valid once open() resolves. */
    open(): Promise<void>;

    /** Send a server frame (push or RPC response; NDJSON serialization is shared by all P0 transports). */
    send(frame: ServerFrame): Promise<void>;

    /** Register inbound request handler. Called once per NDJSON line. */
    onRequest(handler: (raw: string) => void): void;

    /** Graceful shutdown. */
    close(): Promise<void>;
}
