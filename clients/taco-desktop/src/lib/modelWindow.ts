/**
 * Parse a user-entered context-window token count.
 *
 * Accepts a plain token count or the usual k/m shorthand ("128k", "1.5m",
 * case-insensitive). Anything that does not match — empty, garbage, zero or
 * negative — resolves to `undefined`, which means "no declared value": the
 * server-side default applies. A silent `parseInt` here would turn "1024k"
 * into 1024 and the usage ring would read 44x over the window.
 */

export function parseModelWindow(raw: string): number | undefined {
    const match = raw
        .trim()
        .toLowerCase()
        .match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const multiplier = match[2] === "k" ? 1000 : match[2] === "m" ? 1_000_000 : 1;
    return Math.round(value * multiplier);
}

/**
 * Display form of a token count — the inverse of what parseModelWindow
 * accepts: 32_000 → "32k", 1_000_000 → "1m", anything else stays the raw
 * number. Used for the preset options in the provider panel.
 */
export function formatModelWindow(tokens: number): string {
    if (tokens > 0 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
    if (tokens > 0 && tokens % 1000 === 0) return `${tokens / 1000}k`;
    return String(tokens);
}
