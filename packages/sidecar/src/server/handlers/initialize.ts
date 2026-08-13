/**
 * `initialize` handler — process-level handshake, the first client → server
 * request after `sidecar.hello`. Validates the client's protocol version
 * with `isCompatibleClientProtocol` and stores the capability declaration.
 * Registered with `command: false` and `turnStart: false`; idempotent and
 * outside `commandRecords` dedup.
 */

import {
    CURRENT_SESSION_FORMAT_VERSION,
    ErrorCodes,
    initializeSchema,
    isCompatibleClientProtocol,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { sidecarVersion } from "../../runtime/runtimeResources.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

interface InitializeRpcParams {
    protocolVersion?: { major?: unknown; minor?: unknown };
    clientCapabilities?: unknown;
}

const SIDECAR_VERSION_STRING = sidecarVersion();

export function registerInitializeHandler(): void {
    registerMethod(
        RPC.initialize,
        false,
        async ({ params, server }) => {
            const p = (params ?? {}) as InitializeRpcParams;
            const incoming = p.protocolVersion;
            if (
                !incoming ||
                typeof incoming.major !== "number" ||
                typeof incoming.minor !== "number"
            ) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "initialize requires params.protocolVersion.{major,minor} as numbers",
                );
            }
            if (
                !isCompatibleClientProtocol({
                    major: incoming.major,
                    minor: incoming.minor,
                })
            ) {
                throw new RpcHandlerError(
                    ErrorCodes.IncompatibleProtocol,
                    `client protocol ${incoming.major}.${incoming.minor} is not supported; server is ${SIDECAR_PROTOCOL_VERSION.major}.${SIDECAR_PROTOCOL_VERSION.minor}`,
                );
            }
            // Capability payload is opaque; the index signature in ClientCapabilities
            // accepts arbitrary future fields. We persist as-is for diagnostic surfaces.
            const clientCapabilities =
                p.clientCapabilities && typeof p.clientCapabilities === "object"
                    ? (p.clientCapabilities as Record<string, unknown>)
                    : {};
            server.markInitialized(clientCapabilities);
            return {
                serverVersion: SIDECAR_VERSION_STRING,
                serverCapabilities: server.getServerCapabilities(),
                protocolVersion: SIDECAR_PROTOCOL_VERSION,
                sessionFormatVersion: CURRENT_SESSION_FORMAT_VERSION,
            };
        },
        { schema: initializeSchema },
    );
}
