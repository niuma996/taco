/**
 * The global-config write schemas — `settings.write` and `config.patch`.
 *
 * They live apart from `settings.ts` because their body is the open
 * `GlobalConfigPatch` shape, which is defined in `config.ts`. Keeping the
 * schemas that reference it in their own module means `config.ts` never has
 * to import a schema module that imports back — the dependency stays one-way.
 */
import { Type } from "typebox";
import type { ConfigPatchParams, SettingsWriteParams } from "../config.js";
import { sessionIdSchema, toolCallIdSchema, workspaceIdSchema } from "./fields.js";

/** The open patch body: the config's field set evolves, so it stays loose. */
const globalPatchBody = Type.Object({}, { additionalProperties: true });

export const settingsWriteSchema = Type.Unsafe<SettingsWriteParams>(
    Type.Object({ global: Type.Optional(globalPatchBody) }, { additionalProperties: false }),
);

/**
 * `config.patch` params — the model's path to the global config.
 *
 * The patch body stays loose (the config shape has many optional fields, and
 * the handler validates what it accepts), but the envelope is strict: an
 * approval prompt needs the session and tool call to route to.
 */
export const configPatchSchema = Type.Unsafe<ConfigPatchParams>(
    Type.Object({
        workspace: workspaceIdSchema,
        sessionId: sessionIdSchema,
        toolCallId: toolCallIdSchema,
        patch: globalPatchBody,
    }),
);
