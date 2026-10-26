/**
 * tools.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/tools.ts`.
 */

import { Type } from "typebox";

export const toolsListSchema = Type.Object({ workspace: Type.String({ minLength: 1 }) });
