/**
 * tools.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/tools.ts`.
 */

import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

export const toolsListSchema = Type.Object({ workspace: workspaceIdSchema });
