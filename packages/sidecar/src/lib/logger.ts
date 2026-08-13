/**
 * Sidecar logging — all writes to stderr. stdout is reserved for NDJSON protocol frames;
 * any write there would corrupt the frame stream, so console.log / process.stdout must never be used.
 *
 * Line format: `<ISO8601> [level] [scope] {k=v} message` — parsed line-by-line by the desktop client,
 * so newlines in the message body are escaped as \n — each log entry is exactly one line.
 *
 * Leaf module: zero internal dependencies; safe to import from any layer.
 * Desensitization is the caller's responsibility, not this module's.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Context fields for child(). Values are restricted to string|number — objects would tempt callers
 * to dump entire payloads, and these fields persist with the log on disk.
 *
 * Encoding is tightly coupled to the desktop parser: keys must be identifier-shaped (invalid keys
 * are silently dropped), and value whitespace is collapsed to `_` while `}` is stripped.
 * Use short identifiers (channelId/sessionId); free-form text belongs in the message body, not in fields.
 *
 * Do not log PII. For IM: only log channelId / sessionId — peerId and chatId are the platform's
 * real user identifiers; to trace a person, use sessionId to look up the conversation jsonl's metadata.imRouting.
 */
export type LogFields = Record<string, string | number>;

export interface Logger {
    error(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
    /** Derives a logger with fixed extra fields; same-named fields are overridden by the child. */
    child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

/**
 * Level is cached after first read. Tests call resetLogLevel() to switch levels.
 * Defaults to info — lifecycle logs would otherwise be suppressed.
 */
let cachedThreshold: number | undefined;

function threshold(): number {
    if (cachedThreshold === undefined) {
        const raw = process.env.TACO_LOG_LEVEL?.toLowerCase();
        cachedThreshold =
            raw && raw in LEVEL_ORDER ? LEVEL_ORDER[raw as LogLevel] : LEVEL_ORDER.info;
    }
    return cachedThreshold;
}

/** Discards the cached level threshold so the next output re-reads TACO_LOG_LEVEL. */
export function resetLogLevel(): void {
    cachedThreshold = undefined;
}

function format(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        // Circular refs or other JSON.stringify failures — fall back to String().
        return String(value);
    }
}

/**
 * Field encoding is tightly coupled to the desktop parser (`sidecarLogLine.ts` FIELD_GROUP_RE):
 * keys must be identifier-shaped (`[A-Za-z_][\w.-]*`), values must not contain whitespace or `}` —
 * if either constraint fails, the parser treats the entire `{...}` block as a plain message, losing
 * the structured context.
 *
 * - Invalid key → silently drop that field (carrying it would only pollute downstream).
 * - Value whitespace → collapsed to a single `_` (ASCII placeholder within `\S*`); `}` is stripped.
 *
 * Field values are restricted to short identifiers (channelId/sessionId etc.); free-form text must
 * go in the message body, not into fields.
 */
const FIELD_KEY_RE = /^[A-Za-z_][\w.-]*$/;

function renderFields(fields: LogFields | undefined): string {
    if (!fields) return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
        if (!FIELD_KEY_RE.test(k)) continue;
        const value = String(v).replace(/\s+/g, "_").replace(/}/g, "");
        parts.push(`${k}=${value}`);
    }
    return parts.length > 0 ? ` {${parts.join(" ")}}` : "";
}

function emit(
    level: LogLevel,
    scope: string,
    fields: LogFields | undefined,
    msg: string,
    args: unknown[],
): void {
    if (LEVEL_ORDER[level] > threshold()) return;
    const parts = args.length > 0 ? `${msg} ${args.map(format).join(" ")}` : msg;
    const line = `${new Date().toISOString()} [${level}] [${scope}]${renderFields(fields)} ${parts}`;
    // \r\n → one \n; a lone \r must also be escaped — terminals treat it as a
    // carriage return and would overwrite the line's start on display.
    process.stderr.write(`${line.replace(/\r\n|\r|\n/g, "\\n")}\n`);
}

function build(scope: string, fields?: LogFields): Logger {
    return {
        error: (msg, ...args) => emit("error", scope, fields, msg, args),
        warn: (msg, ...args) => emit("warn", scope, fields, msg, args),
        info: (msg, ...args) => emit("info", scope, fields, msg, args),
        debug: (msg, ...args) => emit("debug", scope, fields, msg, args),
        child: (extra) => build(scope, { ...fields, ...extra }),
    };
}

export function createLogger(scope: string): Logger {
    return build(scope);
}
