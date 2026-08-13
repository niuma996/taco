/**
 * logger tests — line format, level gating, and child() field inheritance.
 *
 * Run:
 *   pnpm --filter @taco-ai/sidecar test:logger
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLogger, resetLogLevel } from "../../src/lib/logger.ts";

/** Captures stderr writes for the duration of one test. */
function captureStderr(): { lines: () => string[]; restore: () => void } {
    const original = process.stderr.write.bind(process.stderr);
    const out: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
    (process.stderr as any).write = (chunk: any): boolean => {
        out.push(String(chunk));
        return true;
    };
    return {
        lines: () => out.join("").split("\n").filter(Boolean),
        restore: () => {
            // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
            (process.stderr as any).write = original;
        },
    };
}

let cap: ReturnType<typeof captureStderr>;

beforeEach(() => {
    process.env.TACO_LOG_LEVEL = "debug";
    resetLogLevel();
    cap = captureStderr();
});

afterEach(() => {
    cap.restore();
    delete process.env.TACO_LOG_LEVEL;
    resetLogLevel();
});

describe("createLogger line format", () => {
    it("emits `<ISO> [level] [scope] message`", () => {
        createLogger("scope-a").error("boom");
        const [line] = cap.lines();
        assert.match(line ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[error\] \[scope-a\] boom$/);
    });

    it("folds embedded newlines so one log is always one line", () => {
        createLogger("s").error("a\nb\r\nc");
        assert.equal(cap.lines().length, 1);
        assert.match(cap.lines()[0] ?? "", /a\\nb\\nc$/);
    });

    it("escapes a lone \\r, which would otherwise overwrite the line on a terminal", () => {
        createLogger("s").error("before\rafter");
        const [line] = cap.lines();
        assert.doesNotMatch(line ?? "", /\r/);
        assert.match(line ?? "", /before\\nafter$/);
    });

    it("omits the field group when there are no fields", () => {
        createLogger("s").info("plain");
        assert.match(cap.lines()[0] ?? "", /\[s\] plain$/);
    });
});

describe("level gating", () => {
    it("drops levels below the threshold", () => {
        process.env.TACO_LOG_LEVEL = "warn";
        resetLogLevel();
        const log = createLogger("s");
        log.error("e");
        log.warn("w");
        log.info("i");
        log.debug("d");
        const joined = cap.lines().join("\n");
        assert.match(joined, /\[error\]/);
        assert.match(joined, /\[warn\]/);
        assert.doesNotMatch(joined, /\[info\]/);
        assert.doesNotMatch(joined, /\[debug\]/);
    });

    it("falls back to info for an unknown level", () => {
        process.env.TACO_LOG_LEVEL = "bogus";
        resetLogLevel();
        const log = createLogger("s");
        log.info("i");
        log.debug("d");
        const joined = cap.lines().join("\n");
        assert.match(joined, /\[info\]/);
        assert.doesNotMatch(joined, /\[debug\]/);
    });
});

describe("child()", () => {
    it("renders fields as `{k=v}` before the message", () => {
        createLogger("channel:wecom").child({ sid: "s-1" }).warn("prompt rejected");
        assert.match(cap.lines()[0] ?? "", /\[channel:wecom\] \{sid=s-1\} prompt rejected$/);
    });

    it("renders multiple fields space-separated", () => {
        createLogger("channel").child({ channel: "wecom", method: "x" }).error("push failed");
        assert.match(cap.lines()[0] ?? "", /\{channel=wecom method=x\} push failed$/);
    });

    it("merges parent fields, child overriding on conflict", () => {
        createLogger("s").child({ a: "1", b: "2" }).child({ b: "3" }).info("m");
        assert.match(cap.lines()[0] ?? "", /\{a=1 b=3\} m$/);
    });

    it("does not mutate the parent logger", () => {
        const parent = createLogger("s");
        parent.child({ sid: "x" }).info("child");
        parent.info("parent");
        const lines = cap.lines();
        assert.match(lines[0] ?? "", /\{sid=x\} child$/);
        assert.match(lines[1] ?? "", /\[s\] parent$/);
    });

    it("collapses whitespace and strips `}` so the group stays parseable", () => {
        createLogger("s").child({ v: "a}b\nc" }).info("m");
        const line = cap.lines()[0] ?? "";
        assert.match(line, /\{v=ab_c\} m$/);
        assert.equal(cap.lines().length, 1);
    });

    it("folds a space in a value to `_` so the parser keeps the field", () => {
        createLogger("s").child({ sid: "session with space" }).warn("prompt rejected");
        assert.match(cap.lines()[0] ?? "", /\{sid=session_with_space\} prompt rejected$/);
    });

    it("drops a field whose key is not identifier-shaped", () => {
        createLogger("s").child({ "bad key": "x", good: "y" }).info("m");
        assert.match(cap.lines()[0] ?? "", /\{good=y\} m$/);
    });

    it("accepts numeric field values", () => {
        createLogger("s").child({ n: 42 }).info("m");
        assert.match(cap.lines()[0] ?? "", /\{n=42\} m$/);
    });
});
