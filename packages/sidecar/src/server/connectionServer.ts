import {
    type ClientCapabilities,
    ErrorCodes,
    type RpcRequest,
    type RpcResponse,
} from "@taco-ai/protocol";
import type { ClientSinkRegistry } from "./clientSinkRegistry.ts";
import { initializeClient } from "./handlers/initialize.ts";
import { err, normalizeError, ok } from "./rpcResponse.ts";
import type { SidecarServer } from "./server.ts";
import type { Transport } from "./transport.ts";

/** Connection state stays local; runtime, command deduplication and sessions belong to the host. */
export class ConnectionServer {
    private capabilities?: ClientCapabilities;
    private closed = false;

    constructor(
        private readonly host: SidecarServer,
        private readonly transport: Transport,
        private readonly sinks: ClientSinkRegistry,
    ) {}

    async start(): Promise<void> {
        this.transport.onRequest((line) => {
            void this.handleLine(line);
        });
        await this.host.refreshConfiguration();
        await this.transport.open();
    }

    async stop(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.sinks.remove(this.transport);
        await this.transport.close();
    }

    private async handleLine(line: string): Promise<void> {
        if (this.closed) return;
        let req: RpcRequest;
        try {
            req = JSON.parse(line);
        } catch {
            return;
        }
        if (!req || typeof req.id !== "string" || typeof req.method !== "string") return;
        let response: RpcResponse;
        try {
            if (req.method === "initialize") {
                const { capabilities, result } = initializeClient(
                    req.params,
                    this.host.getServerCapabilities(),
                );
                this.capabilities = capabilities;
                this.sinks.add(this.transport);
                response = ok(req.id, result);
            } else if (!this.capabilities) {
                response = err(
                    req.id,
                    ErrorCodes.NotInitialized,
                    "sidecar must be initialized before calling other methods; call initialize first",
                );
            } else {
                response = await this.host.dispatchClientRpc(req, this.capabilities);
            }
        } catch (error) {
            response = normalizeError(req.id, error);
        }
        if (!this.closed) await this.transport.send(response);
    }
}
