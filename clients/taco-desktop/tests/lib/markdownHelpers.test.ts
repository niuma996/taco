/**
 * markdownHelpers pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:markdown
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { stripFrontmatter } from "../../src/lib/markdownHelpers";

describe("stripFrontmatter", () => {
    it("removes a leading frontmatter block and its trailing blank line", () => {
        const src = "---\nname: release-notes\ndescription: Use when…\n---\n\n# Body\n\ntext";
        assert.equal(stripFrontmatter(src), "# Body\n\ntext");
    });

    it("leaves markdown without frontmatter untouched", () => {
        const src = "# Heading\n\nsome text";
        assert.equal(stripFrontmatter(src), src);
    });

    it("keeps a horizontal rule that appears later in the body", () => {
        const src = "---\nname: x\n---\n\nintro\n\n---\n\nafter the rule";
        assert.equal(stripFrontmatter(src), "intro\n\n---\n\nafter the rule");
    });

    it("returns the input unchanged when frontmatter is never closed", () => {
        // Better to show a stray `---` than to swallow the whole document.
        const src = "---\nname: x\ndescription: unterminated";
        assert.equal(stripFrontmatter(src), src);
    });

    it("handles CRLF line endings", () => {
        const src = "---\r\nname: x\r\n---\r\n\r\n# Body";
        assert.equal(stripFrontmatter(src), "# Body");
    });

    it("accepts `...` as a closing marker", () => {
        assert.equal(stripFrontmatter("---\nname: x\n...\n\nbody"), "body");
    });

    it("returns empty string when the body is empty after frontmatter", () => {
        assert.equal(stripFrontmatter("---\nname: x\n---\n"), "");
    });
});
