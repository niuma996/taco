/**
 * markdownHelpers pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:markdown
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    codeChildrenToString,
    extractCodeLanguage,
    stripFrontmatter,
} from "../../src/lib/markdownHelpers";

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

describe("extractCodeLanguage", () => {
    it("returns the language tag from a 'language-<lang>' className", () => {
        assert.equal(extractCodeLanguage("language-python"), "python");
    });

    it("handles language tags containing non-alphanumeric characters", () => {
        assert.equal(extractCodeLanguage("language-c++"), "c++");
    });

    it("returns empty string when className is undefined", () => {
        assert.equal(extractCodeLanguage(undefined), "");
    });

    it("returns empty string when no language class is present", () => {
        assert.equal(extractCodeLanguage("hljs some-other-class"), "");
    });

    it("picks the first language class when multiple are present (shiki prefix case)", () => {
        assert.equal(extractCodeLanguage("shiki language-go"), "go");
    });

    it("does not match 'language-' followed by whitespace (current behavior — defends against future changes)", () => {
        // Document the current regex behavior. The pattern is /language-(\S+)/,
        // so \S+ requires at least one non-whitespace char immediately after
        // "language-". When a space follows (e.g. raw HTML injection like
        // "language- js foo"), there is no match and we return "".
        // react-markdown / shiki don't emit such classNames in practice, but
        // pinning the behavior here means a future regression (e.g. loosening
        // the pattern to allow whitespace) would surface as a test failure.
        assert.equal(extractCodeLanguage("language- js foo"), "");
    });
});

describe("codeChildrenToString", () => {
    it("returns a bare string unchanged", () => {
        assert.equal(codeChildrenToString("hello"), "hello");
    });

    it("stringifies numeric children", () => {
        assert.equal(codeChildrenToString(42), "42");
    });

    it("returns empty string for undefined", () => {
        assert.equal(codeChildrenToString(undefined), "");
    });

    it("joins string array children with no separator (preserves markdown line breaks)", () => {
        assert.equal(codeChildrenToString(["line1\n", "line2\n", "line3"]), "line1\nline2\nline3");
    });
});
