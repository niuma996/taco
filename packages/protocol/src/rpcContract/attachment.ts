/**
 * RPC contract rows — attachment.* — staging files for a prompt.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type { AttachmentStageResult } from "../attachment.js";
import { attachmentStageSchema } from "../schemas/attachment.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const attachmentRows = {
    attachmentStage: row<AttachmentStageResult>()(
        "attachment.stage",
        "workspace",
        attachmentStageSchema,
    ),
};

export const attachmentMethods = domainMethods(attachmentRows);
export const attachmentContract = domainContract(attachmentRows);
export const attachmentSchemas = domainSchemas(attachmentRows);
