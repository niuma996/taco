/**
 * skillDiagnostics — mapping loader warnings + dedupe collisions into the
 * `skills.list` wire shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillNameCollision } from "../../src/skills/dedupeSkills.ts";
import {
    checkSkillFrontmatter,
    type LoaderSkillDiagnostic,
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
} from "../../src/skills/skillDiagnostics.ts";
import type { SkillFrontmatter } from "../../src/skills/skillFrontmatter.ts";

describe("mapLoaderDiagnostics", () => {
    it("passes through every known pi code verbatim", () => {
        const input: LoaderSkillDiagnostic[] = [
            { code: "file_info_failed", message: "stat failed", path: "/a", source: "user" },
            { code: "list_failed", message: "readdir failed", path: "/b", source: "user" },
            { code: "read_failed", message: "EACCES", path: "/c", source: "builtin" },
            { code: "parse_failed", message: "bad yaml", path: "/d", source: "user" },
            { code: "invalid_metadata", message: "no name", path: "/e", source: "user" },
        ];
        const out = mapLoaderDiagnostics(input);

        assert.deepEqual(
            out.map((d) => d.code),
            ["file_info_failed", "list_failed", "read_failed", "parse_failed", "invalid_metadata"],
        );
        // Messages must not be rewritten for known codes.
        assert.deepEqual(
            out.map((d) => d.message),
            ["stat failed", "readdir failed", "EACCES", "bad yaml", "no name"],
        );
        assert.deepEqual(
            out.map((d) => d.source),
            ["user", "user", "builtin", "user", "user"],
        );
    });

    it("omits source when the loader did not supply one", () => {
        const [entry] = mapLoaderDiagnostics([{ code: "read_failed", message: "x", path: "/a" }]);
        assert.ok(!("source" in entry), "source key should be absent, not undefined");
    });

    it("buckets an unrecognized future pi code into parse_failed but keeps it readable", () => {
        // If pi adds a code, emitting it raw would make the protocol union a
        // lie. Falling back must not lose the original name.
        const [entry] = mapLoaderDiagnostics([
            { code: "some_future_code", message: "details here", path: "/a", source: "user" },
        ]);
        assert.equal(entry.code, "parse_failed");
        assert.ok(entry.message.includes("some_future_code"));
        assert.ok(entry.message.includes("details here"));
    });

    it("maps an empty list to an empty list", () => {
        assert.deepEqual(mapLoaderDiagnostics([]), []);
    });
});

describe("mapDuplicateDiagnostics", () => {
    const collision: SkillNameCollision<{ name: string; filePath: string }> = {
        name: "deep-review",
        dropped: { name: "deep-review", filePath: "/app/builtin/deep-review/SKILL.md" },
        keptFrom: { name: "deep-review", filePath: "/work/.taco/skills/deep-review/SKILL.md" },
    };

    it("reports duplicate_name with the loser as `path` and the winner as `shadowedBy`", () => {
        const [entry] = mapDuplicateDiagnostics([collision]);
        assert.equal(entry.code, "duplicate_name");
        // `path` must be the discarded file: that is the one the user has to
        // rename or delete to resolve the collision.
        assert.equal(entry.path, "/app/builtin/deep-review/SKILL.md");
        assert.equal(entry.shadowedBy, "/work/.taco/skills/deep-review/SKILL.md");
        assert.equal(entry.skillName, "deep-review");
    });

    it("names both files in the message so the collision is actionable without extra lookups", () => {
        const [entry] = mapDuplicateDiagnostics([collision]);
        assert.ok(entry.message.includes("deep-review"));
        assert.ok(entry.message.includes("/work/.taco/skills/deep-review/SKILL.md"));
    });

    it("maps an empty list to an empty list", () => {
        assert.deepEqual(mapDuplicateDiagnostics([]), []);
    });
});

describe("checkSkillFrontmatter", () => {
    const PATH = "/work/.taco/skills/x/SKILL.md";
    // The runtime object is raw parsed YAML, so build fixtures as plain objects
    // rather than relying on the (valid-shape) SkillFrontmatter type.
    const codes = (fm: Record<string, unknown>) =>
        checkSkillFrontmatter(fm as SkillFrontmatter, PATH).map((d) => d.code);

    it("returns nothing for a clean frontmatter", () => {
        assert.deepEqual(codes({ runAs: "inline", inlineOnly: true }), []);
        assert.deepEqual(codes({ runAs: "subagent", allowedTools: ["read"] }), []);
        assert.deepEqual(codes({}), []);
    });

    it("flags an unknown runAs value", () => {
        const [entry] = checkSkillFrontmatter(
            { runAs: "parallel" } as unknown as SkillFrontmatter,
            PATH,
        );
        assert.equal(entry.code, "unknown_run_as");
        assert.equal(entry.path, PATH);
        assert.ok(entry.message.includes("parallel"));
    });

    it("flags a non-boolean inlineOnly", () => {
        assert.deepEqual(codes({ inlineOnly: "yes" }), ["invalid_inline_only"]);
    });

    it("flags inlineOnly:true combined with runAs:subagent as unrunnable", () => {
        // The contradiction skillTool rejects at call time — the main reason
        // this check exists is to surface it at load instead.
        assert.deepEqual(codes({ runAs: "subagent", inlineOnly: true }), ["inline_only_conflict"]);
    });

    it("allows inlineOnly:true with runAs:inline", () => {
        assert.deepEqual(codes({ runAs: "inline", inlineOnly: true }), []);
    });

    it("flags a non-array allowedTools", () => {
        assert.deepEqual(codes({ allowedTools: "read" }), ["invalid_allowed_tools"]);
    });

    it("flags an empty allowedTools list", () => {
        const [entry] = checkSkillFrontmatter({ allowedTools: [] }, PATH);
        assert.equal(entry.code, "empty_allowed_tools");
    });

    it("reports several problems at once rather than stopping at the first", () => {
        assert.deepEqual(codes({ runAs: "bogus", allowedTools: "nope" }), [
            "unknown_run_as",
            "invalid_allowed_tools",
        ]);
    });
});
