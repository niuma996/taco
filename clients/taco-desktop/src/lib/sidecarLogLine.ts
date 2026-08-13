/**
 * Parses sidecar stderr lines emitted by `packages/sidecar/src/lib/logger.ts`.
 *
 * Wire format: `<ISO8601> [level] [scope] {k=v k=v} message`, where the `{...}`
 * field group is optional. Lines that don't match (foreign stderr from a
 * spawned tool, node warnings, a crash dump) are returned as level `undefined`
 * so callers can decide — dropping them would hide exactly the output that
 * matters when the sidecar dies unexpectedly.
 */

export type SidecarLogLevel = "error" | "warn" | "info" | "debug";

export interface ParsedLogLine {
    /** undefined when the line is not logger-formatted. */
    level?: SidecarLogLevel;
    scope?: string;
    /** Context fields from the logger's `child({...})`; empty when absent. */
    fields: Record<string, string>;
    /** Message body, or the whole raw line when unparsed. */
    message: string;
    raw: string;
}

const LOG_LINE_RE =
    /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(error|warn|info|debug)\] \[([^\]]+)\] ([\s\S]*)$/;

/**
 * A leading `{...}` counts as a field group only when every entry is
 * `key=value` with an identifier-like key. Otherwise it is message text that
 * merely starts with a brace (a JSON payload, say) and must be left intact.
 */
const FIELD_GROUP_RE = /^\{([A-Za-z_][\w.-]*=\S*(?: [A-Za-z_][\w.-]*=\S*)*)\} ?([\s\S]*)$/;

function parseFields(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of raw.split(" ")) {
        const eq = pair.indexOf("=");
        if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}

export function parseLogLine(raw: string): ParsedLogLine {
    const m = LOG_LINE_RE.exec(raw);
    if (!m) return { fields: {}, message: raw, raw };
    const rest = m[4] ?? "";
    const g = FIELD_GROUP_RE.exec(rest);
    return {
        level: m[2] as SidecarLogLevel,
        scope: m[3],
        fields: g ? parseFields(g[1] ?? "") : {},
        message: g ? (g[2] ?? "") : rest,
        raw,
    };
}

/**
 * Unformatted lines keep the older keyword heuristic: they're the only signal
 * left for output the sidecar didn't route through its logger (native crashes,
 * spawned-tool stderr).
 */
const FOREIGN_ERROR_RE = /error|failed|cannot|EACCES|ENOENT/i;

/**
 * How prominently a line should surface.
 *
 * `error` interrupts (global banner); `warn` is a degradation that must not
 * take the banner over — a skipped corrupt file or a rebuilt cache does not
 * mean the app is broken. Unformatted stderr is treated as `error` when it
 * looks like a crash, since it's all we have to go on.
 */
export function bannerSeverity(parsed: ParsedLogLine): "error" | "warn" | undefined {
    if (parsed.level) {
        if (parsed.level === "error") return "error";
        if (parsed.level === "warn") return "warn";
        return undefined;
    }
    return FOREIGN_ERROR_RE.test(parsed.raw) ? "error" : undefined;
}

/**
 * Banner text: `[scope] {k=v} message`. Timestamp and level are dropped (the
 * banner is already an error affordance); scope says which subsystem failed and
 * the fields say which session. Unparsed lines fall back to the raw line.
 */
export function formatForBanner(parsed: ParsedLogLine): string {
    if (!parsed.scope) return parsed.raw;
    const entries = Object.entries(parsed.fields);
    const fields = entries.length > 0 ? ` {${entries.map(([k, v]) => `${k}=${v}`).join(" ")}}` : "";
    return `[${parsed.scope}]${fields} ${parsed.message}`;
}
