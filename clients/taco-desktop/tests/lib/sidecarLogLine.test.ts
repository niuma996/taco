/**
 * sidecarLogLine pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:logline
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { bannerSeverity, formatForBanner, parseLogLine } from "../../src/lib/sidecarLogLine";

const TS = "2026-08-04T18:59:02.503Z";

describe("parseLogLine", () => {
    it("splits level, scope and message", () => {
        const p = parseLogLine(`${TS} [error] [compactionController] compact(): failed`);
        assert.equal(p.level, "error");
        assert.equal(p.scope, "compactionController");
        assert.equal(p.message, "compact(): failed");
    });

    it("accepts every level the logger emits", () => {
        for (const lvl of ["error", "warn", "info", "debug"] as const) {
            assert.equal(parseLogLine(`${TS} [${lvl}] [sidecar] x`).level, lvl);
        }
    });

    it("keeps scopes containing colons", () => {
        assert.equal(parseLogLine(`${TS} [warn] [memory:hook] m`).scope, "memory:hook");
    });

    it("preserves bracketed content inside the message", () => {
        const p = parseLogLine(`${TS} [error] [session] got [1] and [2]`);
        assert.equal(p.message, "got [1] and [2]");
    });

    it("returns level undefined for foreign stderr", () => {
        const p = parseLogLine("Error: ENOENT, open 'x'");
        assert.equal(p.level, undefined);
        assert.equal(p.scope, undefined);
        assert.equal(p.message, "Error: ENOENT, open 'x'");
    });

    it("does not treat an unknown level as formatted", () => {
        assert.equal(parseLogLine(`${TS} [trace] [sidecar] x`).level, undefined);
    });

    it("always round-trips raw", () => {
        const line = `${TS} [info] [sidecar] listening`;
        assert.equal(parseLogLine(line).raw, line);
    });
});

describe("bannerSeverity", () => {
    it("routes error to the interrupting banner", () => {
        assert.equal(bannerSeverity(parseLogLine(`${TS} [error] [s] boom`)), "error");
    });

    it("routes warn away from the banner", () => {
        assert.equal(bannerSeverity(parseLogLine(`${TS} [warn] [s] careful`)), "warn");
    });

    it("keeps routine degradations out of the banner", () => {
        // Every one of these is a warn in sidecar today; none means the app broke.
        const warns = [
            `${TS} [warn] [taco-ext] extension "x" overrode built-in tool "read"`,
            `${TS} [warn] [taco-ext] duplicate extension "x"; later source overrides earlier`,
            `${TS} [warn] [channel:router] routing.json unreadable, rebuilding from jsonl: E`,
            `${TS} [warn] [tasks] skipping corrupt task file /p/t.json: bad`,
            `${TS} [warn] [sidecar] skill BAD at /p/s.md: oops`,
            `${TS} [warn] [taco:prompt] unreplaced placeholders: {{FOO}}`,
        ];
        for (const line of warns) {
            assert.equal(bannerSeverity(parseLogLine(line)), "warn", line);
        }
    });

    it("ignores info and debug even when the text says 'failed'", () => {
        assert.equal(bannerSeverity(parseLogLine(`${TS} [info] [s] failed to nothing`)), undefined);
        assert.equal(bannerSeverity(parseLogLine(`${TS} [debug] [s] cannot x`)), undefined);
    });

    it("treats crash-looking foreign stderr as an error", () => {
        assert.equal(bannerSeverity(parseLogLine("Error: ENOENT")), "error");
        assert.equal(bannerSeverity(parseLogLine("node: some notice")), undefined);
    });
});

describe("parseLogLine — context fields", () => {
    it("extracts a field and strips it from the message", () => {
        const p = parseLogLine(`${TS} [warn] [channel:wecom] {sid=s-1} prompt rejected`);
        assert.deepEqual(p.fields, { sid: "s-1" });
        assert.equal(p.message, "prompt rejected");
    });

    it("extracts multiple fields", () => {
        const p = parseLogLine(`${TS} [error] [channel] {channel=wecom method=x} push failed`);
        assert.deepEqual(p.fields, { channel: "wecom", method: "x" });
        assert.equal(p.message, "push failed");
    });

    it("yields empty fields when the group is absent", () => {
        const p = parseLogLine(`${TS} [info] [sidecar] listening`);
        assert.deepEqual(p.fields, {});
        assert.equal(p.message, "listening");
    });

    it("does not mistake a braced message for a field group", () => {
        const p = parseLogLine(`${TS} [error] [s] {"json":true} decode failed`);
        assert.deepEqual(p.fields, {});
        assert.equal(p.message, '{"json":true} decode failed');
    });

    it("keeps '=' inside a field value", () => {
        assert.deepEqual(parseLogLine(`${TS} [warn] [s] {q=a=b} m`).fields, { q: "a=b" });
    });

    it("reports empty fields for unformatted lines", () => {
        assert.deepEqual(parseLogLine("Error: ENOENT").fields, {});
    });
});

describe("formatForBanner", () => {
    it("drops timestamp and level, keeps scope", () => {
        const p = parseLogLine(`${TS} [error] [compactionController] compact failed`);
        assert.equal(formatForBanner(p), "[compactionController] compact failed");
    });

    it("keeps context fields so the failing session is identifiable", () => {
        const p = parseLogLine(`${TS} [warn] [channel:wecom] {sid=s-1} prompt rejected`);
        assert.equal(formatForBanner(p), "[channel:wecom] {sid=s-1} prompt rejected");
    });

    it("falls back to raw for unformatted lines", () => {
        assert.equal(formatForBanner(parseLogLine("Error: ENOENT")), "Error: ENOENT");
    });
});

/**
 * Round-trip: the field-group shapes the sidecar producer can emit after its
 * `renderFields` encoding must all survive this parser. The producer collapses
 * value whitespace to `_` and drops non-identifier keys, so these lines are
 * what the wire actually carries — the parser must recover them as structured
 * fields, not swallow them into the message. Keep in lockstep with
 * `packages/sidecar/src/lib/logger.ts`.
 */
describe("producer → parser round-trip", () => {
    it("recovers a whitespace-folded value", () => {
        const p = parseLogLine(
            `${TS} [warn] [channel:test] {sid=session_with_space} prompt rejected`,
        );
        assert.deepEqual(p.fields, { sid: "session_with_space" });
        assert.equal(p.message, "prompt rejected");
    });

    it("recovers multiple identifier-keyed fields", () => {
        const p = parseLogLine(
            `${TS} [error] [channel] {channel=wecom method=session.prompt} push failed`,
        );
        assert.deepEqual(p.fields, { channel: "wecom", method: "session.prompt" });
        assert.equal(p.message, "push failed");
    });

    it("keeps `=` inside a value", () => {
        const p = parseLogLine(`${TS} [warn] [s] {q=a=b} m`);
        assert.deepEqual(p.fields, { q: "a=b" });
    });
});
