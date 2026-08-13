/**
 * validateCommandPermissions — field allowlist, pattern strings, reject legacy object migration.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { validateCommandPermissions } from "../../src/config/config.ts";

describe("validateCommandPermissions", () => {
    it("returns the default ask config for nullish input", () => {
        assert.deepEqual(validateCommandPermissions(undefined, "t"), { mode: "ask", rules: [] });
        assert.deepEqual(validateCommandPermissions(null, "t"), { mode: "ask", rules: [] });
    });

    it("rejects non-object input", () => {
        assert.throws(() => validateCommandPermissions("ask", "t"), /expected object/);
    });

    it("normalizes unknown mode to ask", () => {
        const v = validateCommandPermissions({ mode: "bypass", rules: [] }, "t");
        assert.equal(v.mode, "ask");
    });

    it("accepts string patterns directly", () => {
        const v = validateCommandPermissions(
            { mode: "ask", rules: ["mmx *", "pnpm test", "git *"] },
            "t",
        );
        assert.deepEqual(v.rules, ["mmx *", "pnpm test", "git *"]);
    });

    it("trims and deduplicates string rules", () => {
        const v = validateCommandPermissions(
            { mode: "ask", rules: ["  pnpm test  ", "pnpm test"] },
            "t",
        );
        assert.deepEqual(v.rules, ["pnpm test"]);
    });

    it("rejects legacy { kind: exact, command } with an error", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    { mode: "ask", rules: [{ kind: "exact", command: "pnpm test" }] },
                    "t",
                ),
            /legacy { kind, command } shape is no longer supported/,
        );
    });

    it("rejects legacy { kind: prefix, command } with an error", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    { mode: "auto", rules: [{ kind: "prefix", command: "mmx " }] },
                    "t",
                ),
            /legacy { kind, command } shape is no longer supported/,
        );
    });

    it("rejects the first legacy entry in a mixed list with an error", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    {
                        mode: "auto",
                        rules: [
                            { kind: "exact", command: "ls" },
                            "ls",
                            { kind: "prefix", command: "git " },
                            "git *",
                        ],
                    },
                    "t",
                ),
            /legacy { kind, command } shape is no longer supported/,
        );
    });

    it("skips empty or whitespace-only string entries", () => {
        const v = validateCommandPermissions(
            {
                mode: "ask",
                rules: ["", "   ", "bash -c 'echo hi'"],
            },
            "t",
        );
        assert.equal(v.rules.length, 0);
    });

    it("rejects legacy rules whose base is a shell wrapper", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    {
                        mode: "auto",
                        rules: [{ kind: "exact", command: "bash -c 'rm -rf /'" }],
                    },
                    "t",
                ),
            /legacy { kind, command } shape is no longer supported/,
        );
    });

    it("rejects malformed non-string entries that aren't legacy shapes", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    {
                        mode: "ask",
                        rules: [null, { kind: "regex", command: ".*" }],
                    },
                    "t",
                ),
            /rules\[\d+\] must be a string pattern/,
        );
    });
});
