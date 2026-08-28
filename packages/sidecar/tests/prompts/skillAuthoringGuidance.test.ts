/**
 * formatSkillAuthoringGuidance — renders defaultSkillDirs into model-visible
 * text (path discovery) plus the taco-private frontmatter contract.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/prompts/skillAuthoringGuidance.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSkillDirs } from "../../src/config/config.ts";
import { formatSkillAuthoringGuidance } from "../../src/prompts/skillAuthoringGuidance.ts";

describe("formatSkillAuthoringGuidance", () => {
    it("always includes the path-discovery preamble, regardless of dir count", () => {
        // Structural assertion independent of how many dirs defaultSkillDirs
        // happens to return — a future change that trims the writable list
        // to zero must not make this silently pass on an empty guidance
        // string.
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(guidance.includes("checked in order, first match by name wins"));
    });

    it("lists every user-writable dir from defaultSkillDirs, in order", () => {
        const cwd = "/work/project";
        const guidance = formatSkillAuthoringGuidance(cwd);
        const dirs = defaultSkillDirs(cwd);
        const writable = dirs.filter((d) => d.source === "user");

        assert.ok(writable.length > 0, "expected at least one writable skill dir");
        let lastIndex = -1;
        for (const dir of writable) {
            const idx = guidance.indexOf(dir.path);
            assert.ok(idx !== -1, `expected guidance to mention ${dir.path}`);
            assert.ok(idx > lastIndex, `expected ${dir.path} to appear after the previous dir`);
            lastIndex = idx;
        }
    });

    it("separates the dir list from the frontmatter section with a blank line", () => {
        // Regression: an earlier version built the blank separator as a `""`
        // array entry and dropped it via `.filter((l) => l !== "")` alongside
        // the conditionally-omitted builtin-readonly line, so the two
        // sections ran together with no paragraph break in every case.
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(
            guidance.includes("overwrite it).\n\nSKILL.md needs YAML frontmatter"),
            "expected a blank line between the dir list/read-only callout and the frontmatter section",
        );
    });

    it("flags the builtin dir as read-only rather than listing it as writable", () => {
        const cwd = "/work/project";
        const guidance = formatSkillAuthoringGuidance(cwd);
        const builtin = defaultSkillDirs(cwd).find((d) => d.source === "builtin");
        assert.ok(builtin, "expected defaultSkillDirs to include a builtin entry");
        assert.ok(guidance.includes(builtin.path));
        assert.ok(guidance.toLowerCase().includes("read-only"));
    });

    it("documents the taco-private frontmatter keys", () => {
        const guidance = formatSkillAuthoringGuidance("/work/project");
        for (const key of ["runAs", "inlineOnly", "allowedTools", "model"]) {
            assert.ok(guidance.includes(key), `expected guidance to mention ${key}`);
        }
    });

    it("documents hot reload and the already-open session discovery limitation", () => {
        const guidance = formatSkillAuthoringGuidance("/work/project");
        assert.ok(guidance.toLowerCase().includes("automatically"));
        assert.ok(guidance.includes("already-open session"));
        assert.ok(guidance.includes("<available_skills>"));
    });

    it("resolves relative to the given cwd, not a hardcoded path", () => {
        const a = formatSkillAuthoringGuidance("/work/project-a");
        const b = formatSkillAuthoringGuidance("/work/project-b");
        assert.notEqual(a, b);
    });
});
