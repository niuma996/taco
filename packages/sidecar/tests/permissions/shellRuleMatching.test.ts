/**
 * shellRuleMatching unit tests — parsePermissionRule / matchWildcardPattern / validatePermissionRule.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    matchWildcardPattern,
    parsePermissionRule,
    validatePermissionRule,
} from "../../src/permissions/shellRuleMatching.ts";

describe("parsePermissionRule", () => {
    it("detects exact match", () => {
        assert.deepEqual(parsePermissionRule("pnpm test"), { type: "exact", command: "pnpm test" });
    });

    it("detects wildcard pattern", () => {
        const p = parsePermissionRule("mmx *");
        assert.equal(p.type, "wildcard");
        if (p.type === "wildcard") assert.equal(p.pattern, "mmx *");
    });

    it("detects suffix wildcard", () => {
        const p = parsePermissionRule("* install");
        assert.equal(p.type, "wildcard");
    });

    it("detects mid-string wildcard", () => {
        const p = parsePermissionRule("git checkout * main");
        assert.equal(p.type, "wildcard");
    });

    it("treats escaped asterisk as literal (not wildcard)", () => {
        const p = parsePermissionRule("git log \\*");
        assert.equal(p.type, "exact");
    });

    it("treats `X *` as a wildcard (legacy `X:*` prefix syntax is gone)", () => {
        const p = parsePermissionRule("npm *");
        assert.equal(p.type, "wildcard");
        if (p.type === "wildcard") assert.equal(p.pattern, "npm *");
        // The legacy `X:*` form no longer parses as a prefix; `npm:*` now
        // matches only commands containing a literal colon, so it must be
        // written as `npm *`.
        assert.equal(parsePermissionRule("npm:*").type, "wildcard");
    });
});

describe("matchWildcardPattern", () => {
    it("matches an exact pattern with wildcard", () => {
        assert.ok(matchWildcardPattern("mmx *", "mmx search query --q hi"));
    });

    it("matches a single-wildcard pattern without trailing args (optional space+args)", () => {
        assert.ok(matchWildcardPattern("git *", "git"));
        assert.ok(matchWildcardPattern("git *", "git add"));
    });

    it("rejects a prefix mismatch", () => {
        assert.ok(!matchWildcardPattern("mmx *", "mmxly foo"));
    });

    it("matches suffix wildcard", () => {
        assert.ok(matchWildcardPattern("* install", "npm install"));
        assert.ok(matchWildcardPattern("* install", "yarn install"));
        assert.ok(!matchWildcardPattern("* install", "install"));
    });

    it("matches mid-string wildcard", () => {
        assert.ok(matchWildcardPattern("git checkout * main", "git checkout feature main"));
        assert.ok(!matchWildcardPattern("git checkout * main", "git reset feature main"));
    });

    it("handles escaped asterisk as a literal character", () => {
        assert.ok(matchWildcardPattern("git log \\*", "git log *"));
        assert.ok(!matchWildcardPattern("git log \\*", "git log all"));
    });
});

describe("validatePermissionRule", () => {
    it("accepts a non-empty pattern", () => {
        const r = validatePermissionRule("mmx *");
        assert.equal(r.valid, true);
        if (r.valid) assert.equal(r.canonical, "mmx *");
    });

    it("rejects empty string", () => {
        const r = validatePermissionRule("  ");
        assert.equal(r.valid, false);
        if (!r.valid) assert.match(r.reason, /empty/);
    });

    it("rejects shell wrapper as base command", () => {
        const r = validatePermissionRule("bash -c 'echo hi'");
        assert.equal(r.valid, false);
        if (!r.valid) assert.match(r.reason, /shell wrapper/i);
    });

    it("rejects powershell and cmd wrappers too", () => {
        assert.equal(
            validatePermissionRule("powershell -c 'Remove-Item -Recurse -Force C:\\foo'").valid,
            false,
        );
        assert.equal(validatePermissionRule("cmd /c del /f /q C:\\foo").valid, false);
    });
});
