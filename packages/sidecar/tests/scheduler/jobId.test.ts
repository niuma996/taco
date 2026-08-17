import { strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { assertSafeJobId, isSafeJobId } from "../../src/scheduler/jobId.ts";

test("isSafeJobId accepts ASCII letters, digits, dash, underscore", () => {
    strictEqual(isSafeJobId("nightly-cleanup"), true);
    strictEqual(isSafeJobId("a"), true);
    strictEqual(isSafeJobId("ABC_123"), true);
});

test("isSafeJobId rejects path traversal and shell metacharacters", () => {
    for (const bad of [
        "",
        ".",
        "..",
        "../target",
        "/abs",
        "foo/bar",
        "foo\\bar",
        "a b",
        "a\nb",
        "a;b",
        "a&b",
        "$(whoami)",
        "`id`",
        "a*",
        "a?",
        "a\x00b",
        "x".repeat(65),
    ]) {
        strictEqual(isSafeJobId(bad), false, `expected reject: ${JSON.stringify(bad)}`);
    }
});

test("assertSafeJobId throws with reason on invalid input", () => {
    throws(() => assertSafeJobId("../escape"), /job id must match/);
});
