/**
 * extensions.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/extensions.ts`.
 */

import { noParamsSchema } from "./workspace.js";

/** `extensions.status` takes no arguments; the client sends no `params`. */
export const extensionsStatusSchema = noParamsSchema;
