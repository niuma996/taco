import type { ChannelManifest } from "./types.ts";

/** channelId validity: no /, %, . — guarantees makeImCwd concatenation is safe. */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidChannelId(channelId: string): boolean {
    return CHANNEL_ID_PATTERN.test(channelId);
}

/** Minimal hand-written validation (no zod). Returns a union type, no exceptions. */
export function validateChannelConfigValues(
    manifest: ChannelManifest,
    config: Record<string, unknown>,
):
    | { ok: true; validated: Record<string, string | boolean | number> }
    | { ok: false; error: string } {
    const validated: Record<string, string | boolean | number> = {};
    for (const field of manifest.configSchema) {
        const value = config[field.key];
        if (value === undefined || value === null) {
            if (field.required) {
                return { ok: false, error: `missing required field: ${field.key}` };
            }
            continue;
        }
        const t = field.type;
        const ok =
            t === "string" || t === "secret"
                ? typeof value === "string"
                : t === "boolean"
                  ? typeof value === "boolean"
                  : t === "number"
                    ? typeof value === "number"
                    : false;
        if (!ok) {
            // Type mismatch is non-fatal: forward the original value and warn (stderr written by caller)
            validated[field.key] = value as string | boolean | number;
            continue;
        }
        validated[field.key] = value as string | boolean | number;
    }
    return { ok: true, validated };
}
