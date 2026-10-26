/**
 * `initialize` handler — process-level handshake, the first client → server
 * request on every connection. Validates the client's protocol version
 * with `isCompatibleClientProtocol` and stores the capability declaration.
 * Registered with `command: false` and `turnStart: false`; idempotent and
 * outside `commandRecords` dedup.
 */

import {
    CURRENT_SESSION_FORMAT_VERSION,
    ErrorCodes,
    type InitializeParams,
    isCompatibleClientProtocol,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { sidecarVersion } from "../../runtime/runtimeResources.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { SIDECAR_INSTANCE_ID } from "../push.ts";

/**
 * The version object as it may arrive on the wire.
 *
 * The keys come from the contract so a rename in `InitializeParams` breaks
 * this type rather than silently detaching the handler from it. The values
 * stay `unknown` because the checks below are what decide what a version
 * is — this method's schema is deliberately permissive.
 */
type LooseProtocolVersion = { [K in keyof InitializeParams["protocolVersion"]]?: unknown };

/**
 * `initialize` params as they may arrive on the wire.
 *
 * The contract declares both fields required, but the frame is untrusted: a
 * client may omit one or send a malformed value, and the handler has to
 * answer `invalid_params` rather than crash reading `undefined.major`.
 * Deriving the field names from the contract keeps the two linked — a
 * rename in `InitializeParams` breaks this type instead of leaving the
 * handler reading a field that no longer exists.
 */
type LooseInitializeParams = {
    [K in keyof InitializeParams]?: K extends "protocolVersion" ? LooseProtocolVersion : unknown;
};

const SIDECAR_VERSION_STRING = sidecarVersion();

export function registerInitializeHandler(): void {
    registerMethod("initialize", false, async ({ params, server }) => {
        const p = (params ?? {}) as LooseInitializeParams;
        const incoming = p.protocolVersion;
        if (!incoming || typeof incoming.major !== "number" || typeof incoming.minor !== "number") {
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
            instanceId: SIDECAR_INSTANCE_ID,
            pid: process.pid,
        };
    });
}
