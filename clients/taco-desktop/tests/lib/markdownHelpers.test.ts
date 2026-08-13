/**
 * markdownHelpers pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:markdown
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { codeChildrenToString, extractCodeLanguage } from "../../src/lib/markdownHelpers";

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
