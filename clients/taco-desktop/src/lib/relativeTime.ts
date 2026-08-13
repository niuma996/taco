/**
 * Format an ISO timestamp for the session list:
 *  - < 1 day: relative ("3 hours ago") via Intl.RelativeTimeFormat.
 *  - 1-7 days: weekday + time ("Tue 15:09" / "周二 15:09").
 *  - ≥ 7 days: date + time ("2025/3/4 08:58"), so older entries stay unambiguous.
 * `now` is passed in to keep the helper pure and unit-testable.
 */
export function formatRelativeTime(iso: string, locale: string, now: number): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const diffMs = t - now; // negative = past
    const absSec = Math.abs(diffMs) / 1000;

    if (absSec >= 60 * 60 * 24 * 7) {
        return new Date(t).toLocaleString(locale, {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    if (absSec >= 60 * 60 * 24) {
        return new Date(t).toLocaleString(locale, {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    // Under a day: relative buckets — seconds < 45s, then minutes.
    const value = absSec < 45 ? Math.round(diffMs / 1000) : Math.round(diffMs / 60_000);
    const unit: Intl.RelativeTimeFormatUnit = absSec < 45 ? "second" : "minute";
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
