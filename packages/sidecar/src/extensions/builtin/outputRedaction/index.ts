/**
 * Built-in output redaction extension.
 *
 * Scans every tool result for common secret patterns (API keys, tokens,
 * private keys) and replaces them with `[REDACTED:TYPE]` before the result
 * reaches the LLM or UI. Scans only `TextContent` (leaves `ImageContent`
 * untouched). Fail-silent: on error, passes the original content through.
 * Zero-overhead on miss: returns `undefined` when nothing was redacted.
 */

import type { ToolResultEvent, ToolResultPatch } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { createLogger } from "../../../lib/logger.ts";
import type { BuiltinManifest } from "../../builtinContract.ts";
import type { ToolResultHook } from "../../types.ts";

const log = createLogger("output-redaction");

/**
 * Each entry is a globally-replacing pattern (g flag).
 *
 * Modern provider keys contain `-` (Anthropic sk-ant-api03-, OpenAI
 * sk-proj-/sk-svcacct-) or `_` (e.g. sk-cp-..._...). Character class
 * `[A-Za-z0-9_-]` (incl. `-` `_`) matches provider body segments; provider
 * prefix is mandatory to avoid false positives on short base62 strings.
 */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
    // Anthropic: sk-ant-... or sk-ant-api03-... (contains '-')
    { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
    // OpenAI modern: sk-proj-... / sk-svcacct-... (contains '-')
    { re: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
    // minimax-cn: sk-cp-..._..._... (contains '_')
    { re: /\bsk-cp-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
    // Fallback: other sk- prefixed keys (unknown provider). 32+ char body
    // avoids false positives on short base62 strings; observed provider keys
    // are well above 40 chars. If a new provider's keys are shorter than 32,
    // add an explicit prefixed rule above instead of lowering this threshold.
    { re: /\bsk-[A-Za-z0-9_-]{32,}\b/g, label: "API_KEY" },
    // AWS Access Key ID
    { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY" },
    // GitHub tokens (ghp_ / gho_ / ghs_ / ghr_ prefixes)
    { re: /\bgh[posr]_[A-Za-z0-9]{36}\b/g, label: "GITHUB_TOKEN" },
    // Bearer token in HTTP Authorization header value
    { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, label: "BEARER_TOKEN" },
    // PEM private key block (entire multi-line block replaced as one unit)
    {
        re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
        label: "PRIVATE_KEY",
    },
];

/**
 * Redact secrets from a single string, returning `[redacted, wasModified]`.
 * Exported so push.ts can scrub `tool_execution_start` arguments before they
 * reach the desktop UI.
 */
export function redactString(s: string): [string, boolean] {
    let hit = false;
    let out = s;
    for (const { re, label } of PATTERNS) {
        out = out.replace(re, () => {
            hit = true;
            return `[REDACTED:${label}]`;
        });
    }
    return [out, hit];
}

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
 * Redact secrets from an arbitrary JSON-serializable value, returning
 * `[redacted, wasModified]`. Round-trips through JSON to flatten into a string,
 * runs the same patterns, then parses back. Returns the original value on
 * serialization failure (BigInt/functions/Symbols/cycles) and emits a
 * warn so operators can detect redaction-skip cases.
 */
export function redactUnknown(value: unknown): [unknown, boolean] {
    if (value === undefined || value === null) return [value, false];
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch (e) {
        // Caller passed something that isn't JSON-serializable — passing
        // the original through is unsafe (potential raw-key leak), but
        // blocking the tool result is worse. Log so the operator sees it.
        log.warn("value not JSON-serializable; skipping redaction", e);
        return [value, false];
    }
    const [redacted, hit] = redactString(serialized);
    if (!hit) return [value, false];
    return [JSON.parse(redacted), true];
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
    description:
        "Redacts common secrets (OpenAI keys, AWS access keys, GitHub tokens, bearer tokens, PEM private keys) from tool result content before it reaches the model or UI.",
    whenToUse:
        "Built-in. Disable via `disabledExtensions` in ~/.taco/taco.json if you want tool secrets to pass through to the LLM unredacted (not recommended).",
    register: (registry) => {
        registry.addToolResultInterceptor("builtin", buildOutputRedactionHook());
    },
};
