/**
 * settings.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/settings.ts`.
 *
 * The global-config *write* schemas live in `globalConfig.ts`; the ones here
 * carry no body.
 */

import { noParamsSchema } from "./workspace.js";

export const settingsGetSchema = noParamsSchema;
