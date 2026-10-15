/**
 * Format a timestamp for every user-facing clock in the desktop UI.
 *
 *  - < 45s: relative seconds ("10 seconds ago").
 *  - < 1h: relative minutes ("5 minutes ago").
 *  - < 1 day: hours plus leftover minutes ("13 hours 20 minutes ago").
 *    A zero leftover is omitted ("2 hours ago").
 *  - 1–7 days: weekday + time ("Tue 15:09" / "周二 15:09").
 *  - ≥ 7 days: date + time ("2025/3/4 08:58").
 *
 * `input` is an ISO string, epoch milliseconds, or an epoch-millisecond
 * string. `now` is injected so the helper stays pure.
 */
export function formatRelativeTime(input: string | number, locale: string, now: number): string {
    const t = parseDisplayTime(input);
    if (Number.isNaN(t)) return "";
    const diffMs = t - now;
    const absMs = Math.abs(diffMs);

    if (absMs >= WEEK_MS) return formatAbsolute(t, locale, true);
    if (absMs >= DAY_MS) return formatAbsolute(t, locale, false);

    if (absMs < 45_000) {
        return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
            Math.round(diffMs / 1000),
            "second",
        );
    }

    const signedMinutes = Math.round(diffMs / 60_000);
    const absMinutes = Math.abs(signedMinutes);
    // Rounding can push a 23h59.6m stamp over the day boundary. Promote it
    // instead of rendering "24 hours ago" next to weekday stamps.
    if (absMinutes >= 24 * 60) return formatAbsolute(t, locale, false);
    if (absMinutes >= 60) return formatHoursAndMinutes(locale, signedMinutes);
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(signedMinutes, "minute");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function parseDisplayTime(input: string | number): number {
    if (typeof input === "number") return input;
    const trimmed = input.trim();
    if (trimmed === "") return Number.NaN;
    // All-digit strings are epoch milliseconds, not ISO. Date.parse("1789…") is NaN.
    if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : Number.NaN;
    }
    return Date.parse(trimmed);
}

function formatAbsolute(t: number, locale: string, withDate: boolean): string {
    return new Date(t).toLocaleString(
        locale,
        withDate
            ? {
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
              }
            : { weekday: "short", hour: "2-digit", minute: "2-digit" },
    );
}

/** RelativeTimeFormat is one unit; DurationFormat is not in this runtime. */
function formatHoursAndMinutes(locale: string, signedMinutes: number): string {
    const sign = signedMinutes < 0 ? -1 : 1;
    const abs = Math.abs(signedMinutes);
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
    if (minutes === 0) return rtf.format(sign * hours, "hour");
    if (hours === 0) return rtf.format(sign * minutes, "minute");

    const hourText = unitPhrase(locale, sign * hours, "hour");
    const minuteText = unitPhrase(locale, sign * minutes, "minute");
    const sample = rtf.format(sign, "hour");
    if (sample.includes("前") || sample.includes("后")) {
        return `${hourText}${minuteText}${sign < 0 ? "前" : "后"}`;
    }
    return sign < 0 ? `${hourText} ${minuteText} ago` : `in ${hourText} ${minuteText}`;
}

/** Number + unit word, without the direction RelativeTimeFormat glues on. */
function unitPhrase(locale: string, signed: number, unit: "hour" | "minute"): string {
    const parts = new Intl.RelativeTimeFormat(locale, { numeric: "always" }).formatToParts(
        signed,
        unit,
    );
    return parts
        .map((part) => part.value)
        .join("")
        .replace(/^\s*in\s+/i, "")
        .replace(/\s*ago\s*$/i, "")
        .replace(/[前后]\s*$/u, "")
        .trim();
}
