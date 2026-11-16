/**
 * Built-in output redaction extension.
 *
 * Scans every tool result for common secret patterns (API keys, tokens,
 * private keys) and replaces them with `[REDACTED:TYPE]` before the result
 * reaches the LLM. Core display redaction is independent of this plugin.
 * Scans only text; images pass through. On error, preserves the tool result.
 * Zero-overhead on miss: returns `undefined` when nothing was redacted.
 */

import type { ToolResultEvent, ToolResultPatch } from "../../../extensions/types.ts";
import { redactString, redactUnknown } from "../../../lib/secretRedaction.ts";
import type { TextContent } from "../../../runtime/pi/types.ts";
import type { BuiltinManifest } from "../../builtinContract.ts";
import type { ToolResultHook } from "../../types.ts";

/**
 * Redact secrets from a TextContent item.
 * Returns [redacted, wasModified] — the returned item has the same reference
 * when no hit occurred (zero-copy).
 */
function redactTextContent(item: TextContent): [TextContent, boolean] {
    const [redacted, hit] = redactString(item.text);
    if (hit) return [{ ...item, text: redacted }, true];
    return [item, false];
}

/**
 * Redact secrets from a JSON-serializable `details` payload.
 * Thin wrapper over `redactUnknown`; kept for symmetry with
 * `redactTextContent`; new call sites should use `redactUnknown` directly.
 */
function redactDetails(details: unknown): [unknown, boolean] {
    return redactUnknown(details);
}

export function buildOutputRedactionHook(): ToolResultHook {
    return async (event: ToolResultEvent): Promise<ToolResultPatch | undefined> => {
        try {
            if (event.content.length === 0 && event.details === undefined) return undefined;

            let hit = false;
            const patched = event.content.map((item) => {
                if (item.type !== "text") return item;
                const [redacted, h] = redactTextContent(item);
                if (h) hit = true;
                return redacted;
            });

            const [detailsPatched, detailsHit] = redactDetails(event.details);
            if (detailsHit) hit = true;

            if (!hit) return undefined;
            const patch: ToolResultPatch = { content: patched };
            if (detailsHit) patch.details = detailsPatched;
            return patch;
        } catch {
            // Fail-silent: never block the tool result on redaction error.
            return undefined;
        }
    };
}

/** Builtin manifest — self-describes metadata and registration logic. */
export const manifest: BuiltinManifest = {
    name: "@taco/builtin-output-redaction",
    version: "0.2.0",
    description:
        "Redacts common secrets (OpenAI keys, AWS access keys, GitHub tokens, bearer tokens, PEM private keys) from tool result content before it reaches the model. Core display redaction stays enabled independently.",
    configSchema: { type: "object", additionalProperties: false },
    whenToUse:
        "Use to remove common credentials from model tool results. Disabling this plugin does not disable redaction in UI events and runtime snapshots.",
    register: (registry) => {
        registry.addToolResultInterceptor("builtin", buildOutputRedactionHook());
    },
};
