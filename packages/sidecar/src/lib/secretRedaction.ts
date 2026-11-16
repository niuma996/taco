import { createLogger } from "./logger.ts";

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
 * Exported so push.ts can scrub `tool_start` arguments before they
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
