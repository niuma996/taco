/**
 * relativeTime tests — pure function, `now` is injected so no clock mocking.
 *
 * Absolute-date buckets (≥1 day) go through toLocaleString, which is
 * timezone-dependent; assertions there check shape (digits, a time colon)
 * rather than exact strings. Sub-day buckets use relative phrasing and are
 * asserted exactly.
 *
 * Run:
 *   tsx --test tests/lib/relativeTime.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatRelativeTime } from "../../src/lib/relativeTime";

// Local (non-UTC) noon so a 2-hour offset never crosses a day boundary.
const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

describe("formatRelativeTime", () => {
    it("formats seconds inside 45s", () => {
        assert.equal(
            formatRelativeTime(new Date(NOW - 10_000).toISOString(), "en", NOW),
            "10 seconds ago",
        );
    });

    it("formats minutes under an hour", () => {
        assert.equal(
            formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), "en", NOW),
            "5 minutes ago",
        );
    });

    it("formats sub-day as relative minutes (no absolute date)", () => {
        const out = formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), "en", NOW);
        assert.equal(out, "180 minutes ago");
    });

    it("1+ day shows weekday + time (has a time colon, no year)", () => {
        const out = formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), "en", NOW);
        assert.ok(/:/.test(out), `expected a time in "${out}"`);
        assert.ok(!/\b\d{4}\b/.test(out), `expected no 4-digit year in "${out}"`);
    });

    it("1+ week shows a date + time (has a year and a time colon)", () => {
        const out = formatRelativeTime(new Date(NOW - 10 * 86_400_000).toISOString(), "en", NOW);
        assert.ok(/:/.test(out), `expected a time in "${out}"`);
        assert.ok(/\d{4}|\d{1,2}\/\d{1,2}/.test(out), `expected a date in "${out}"`);
    });

    it("returns empty string for invalid ISO", () => {
        assert.equal(formatRelativeTime("not-a-date", "en", NOW), "");
    });
});
