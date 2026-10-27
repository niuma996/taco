/**
 * skills.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/skills.ts`.
 */

import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

export const skillsListSchema = Type.Object({ workspace });

export const skillContentSchema = Type.Object({
    workspace,
    filePath: Type.String({ minLength: 1 }),
});
