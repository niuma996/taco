/**
 * attachment.* handler — stages a file for the next prompt.
 *
 * Staging is deliberately session-independent: a brand-new conversation has
 * no session yet when the user picks a file. The staged id is later committed
 * into a session by whichever prompt names it (see composePrompt).
 */

import { ErrorCodes } from "@taco-ai/protocol";

import {
    AttachmentError,
    stageFromData,
    stageFromPath,
} from "../../attachments/attachmentStore.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/** Wire code for an attachment refusal. */
function codeFor(error: AttachmentError): string {
    return error.code === "not_found" ? ErrorCodes.NotFound : ErrorCodes.InvalidParams;
}

/**
 * Re-throw an attachment refusal as a wire error the client can show. Any other
 * failure propagates unchanged and is flattened to `internal` by the registry,
 * which is right for a disk fault the user cannot act on.
 *
 * The refusal kind rides in `data.reason`: most of these share the
 * `invalid_params` code, so without it a client cannot tell "too large" from
 * "not a file".
 */
export function rethrowAttachmentError(e: unknown): never {
    if (e instanceof AttachmentError) {
        throw new RpcHandlerError(codeFor(e), e.message, { reason: e.code });
    }
    throw e;
}

export function registerAttachmentHandlers(): void {
    registerMethod(
        "attachmentStage",
        true,
        async ({ cwd, params }) => {
            try {
                if ("path" in params) return await stageFromPath(cwd, params.path);
                return await stageFromData(cwd, params.name, params.data, params.mimeType);
            } catch (e) {
                return rethrowAttachmentError(e);
            }
        },
        { command: true },
    );
}
