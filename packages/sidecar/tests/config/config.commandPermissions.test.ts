/**
 * validateCommandPermissions — field allowlist, pattern strings, reject legacy object migration.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { validateCommandPermissions } from "../../src/config/config.ts";

describe("validateCommandPermissions", () => {
    it("returns the default ask config for nullish input", () => {
        assert.deepEqual(validateCommandPermissions(undefined, "t"), {
            mode: "ask",
            allow: [],
            deny: [],
        });
        assert.deepEqual(validateCommandPermissions(null, "t"), {
            mode: "ask",
            allow: [],
            deny: [],
        });
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
        assert.deepEqual(v.allow, ["mmx *", "pnpm test", "git *"]);
    });

    it("trims and deduplicates string rules", () => {
        const v = validateCommandPermissions(
            { mode: "ask", rules: ["  pnpm test  ", "pnpm test"] },
            "t",
        );
        assert.deepEqual(v.allow, ["pnpm test"]);
    });

    // Every legacy shape below lands on the same `rules[i] must be a string
    // pattern` throw — they are one branch, kept as a table because they are
    // the four ways a user could still have the pre-migration shape on disk.
    it("rejects legacy { kind, command } rules in every shape", () => {
        const legacyShapes: unknown[] = [
            // The original exact-match form.
            { mode: "ask", rules: [{ kind: "exact", command: "pnpm test" }] },
            // The original prefix-match form.
            { mode: "auto", rules: [{ kind: "prefix", command: "mmx " }] },
            // First legacy entry wins in a list that interleaves legacy and
            // string rules — the loop must not skip past it to validate the rest.
            {
                mode: "auto",
                rules: [
                    { kind: "exact", command: "ls" },
                    "ls",
                    { kind: "prefix", command: "git " },
                    "git *",
                ],
            },
            // A legacy rule whose base is a shell wrapper must not slip through
            // as a string pattern.
            {
                mode: "auto",
                rules: [{ kind: "exact", command: "bash -c 'rm -rf /'" }],
            },
        ];

        for (const value of legacyShapes) {
            assert.throws(
                () => validateCommandPermissions(value, "t"),
                /legacy { kind, command } shape is no longer supported/,
            );
        }
    });

    it("skips empty or whitespace-only string entries", () => {
        const v = validateCommandPermissions(
            {
                mode: "ask",
                rules: ["", "   ", "bash -c 'echo hi'"],
            },
            "t",
        );
        assert.equal(v.allow?.length, 0);
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

describe("command permission canonical configuration", () => {
    it("uses an explicit allow list instead of resurrecting legacy rules", () => {
        assert.deepEqual(
            validateCommandPermissions(
                { mode: "ask", allow: [], rules: ["git push *"], deny: ["bash *"] },
                "t",
            ),
            {
                mode: "ask",
                allow: [],
                deny: ["bash *"],
            },
        );
    });

    it("keeps canonical blacklist wrappers and authorized directories", () => {
        assert.deepEqual(
            validateCommandPermissions(
                {
                    mode: "auto",
                    allow: ["bash *", "git diff"],
                    deny: [" bash * ", "bash *"],
                    allowedDirectories: [" /workspace/extra ", "/workspace/extra"],
                },
                "t",
            ),
            {
                mode: "auto",
                allow: ["git diff"],
                deny: ["bash *"],
                allowedDirectories: ["/workspace/extra"],
            },
        );
    });

    it("rejects invalid authorized directory lists", () => {
        for (const allowedDirectories of [
            "/workspace",
            ["relative/path"],
            [""],
            [42],
            ["/workspace\0bad"],
        ]) {
            assert.throws(
                () => validateCommandPermissions({ mode: "ask", allowedDirectories }, "t"),
                /allowedDirectories/,
            );
        }
    });
});
