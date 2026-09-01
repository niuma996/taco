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
    it("emits `<ISO> [level] [scope] message` and folds embedded newlines so one log is always one line", () => {
        createLogger("scope-a").error("boom");
        const [first] = cap.lines();
        assert.match(first ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[error\] \[scope-a\] boom$/);

        createLogger("s").error("a\nb\rafter");
        const folded = cap.lines().at(-1) ?? "";
        // Both \n and \r are escaped so each log is always one line on disk.
        assert.doesNotMatch(folded, /[\n\r]/);
    });

    it("omits the field group when there are no fields", () => {
        createLogger("s").info("plain");
        assert.match(cap.lines()[0] ?? "", /\[s\] plain$/);
    });
});

describe("level gating", () => {
    it("drops levels below the threshold and falls back to info for an unknown level", () => {
        process.env.TACO_LOG_LEVEL = "warn";
        resetLogLevel();
        const warnLog = createLogger("s");
        warnLog.error("e");
        warnLog.warn("w");
        warnLog.info("i");
        warnLog.debug("d");
        const warnJoined = cap.lines().join("\n");
        assert.match(warnJoined, /\[error\]/);
        assert.match(warnJoined, /\[warn\]/);
        assert.doesNotMatch(warnJoined, /\[info\]/);
        assert.doesNotMatch(warnJoined, /\[debug\]/);

        cap.restore();
        cap = captureStderr();
        process.env.TACO_LOG_LEVEL = "bogus";
        resetLogLevel();
        const fallbackLog = createLogger("s");
        fallbackLog.info("i");
        fallbackLog.debug("d");
        const fallbackJoined = cap.lines().join("\n");
        assert.match(fallbackJoined, /\[info\]/);
        assert.doesNotMatch(fallbackJoined, /\[debug\]/);
    });
});

describe("child()", () => {
    it("renders single / multi / merged fields and does not mutate the parent", () => {
        // Single field
        createLogger("channel:wecom").child({ sid: "s-1" }).warn("prompt rejected");
        // Multi fields
        createLogger("channel").child({ channel: "wecom", method: "x" }).error("push failed");
        // Merge with override + parent isolation in one go
        const parent = createLogger("s");
        parent.child({ a: "1", b: "2" }).child({ b: "3" }).info("merged");
        parent.info("parent");

        const lines = cap.lines();
        assert.match(lines[0] ?? "", /\{sid=s-1\} prompt rejected$/);
        assert.match(lines[1] ?? "", /\{channel=wecom method=x\} push failed$/);
        assert.match(lines[2] ?? "", /\{a=1 b=3\} merged$/);
        assert.match(lines[3] ?? "", /\[s\] parent$/);
    });

    it("sanitizes field values (whitespace → _, strips `}`, embedded \\r / \\n escaped)", () => {
        createLogger("s").child({ v: "a}b\nc", sid: "session with space" }).info("m");
        const line = cap.lines()[0] ?? "";
        assert.match(line, /\{v=ab_c sid=session_with_space\} m$/);
        assert.doesNotMatch(line, /[\n\r]/);
        assert.equal(cap.lines().length, 1);
    });

    it("drops non-identifier keys and accepts numeric values", () => {
        createLogger("s").child({ "bad key": "x", good: "y", n: 42 }).info("m");
        assert.match(cap.lines()[0] ?? "", /\{good=y n=42\} m$/);
    });
});
