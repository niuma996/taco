import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseYamlFrontmatter } from "../../src/skills/skillFrontmatter.ts";

describe("parseYamlFrontmatter", () => {
    it("returns empty object when no frontmatter block is present", () => {
        assert.deepEqual(parseYamlFrontmatter("just markdown body\n"), {});
    });

    it("parses the block as YAML even when not terminated by a closing fence", () => {
        // gray-matter treats an unterminated `---` block as the full YAML
        // document; documenting that behavior so future changes do not regress
        // it silently.
        assert.deepEqual(parseYamlFrontmatter("---\nfoo: bar\n"), { foo: "bar" });
    });

    it("parses top-level scalar values", () => {
        const out = parseYamlFrontmatter(`---
name: my-skill
model: opus
---`);
        assert.equal(out.name, "my-skill");
        assert.equal(out.model, "opus");
    });

    it("parses inline lists", () => {
        const out = parseYamlFrontmatter(`---
allowedTools: [read, write, bash]
---`);
        assert.deepEqual(out.allowedTools, ["read", "write", "bash"]);
    });

    it("ignores comments and blank lines inside the block", () => {
        const out = parseYamlFrontmatter(`---
# a comment
name: my-skill

model: opus
---`);
        assert.equal(out.name, "my-skill");
        assert.equal(out.model, "opus");
    });

    it("preserves the body content outside the block", () => {
        const out = parseYamlFrontmatter(`---
name: my-skill
---
# Heading

body content here`);
        assert.equal(out.name, "my-skill");
    });

    it("normalizes CRLF line endings", () => {
        const out = parseYamlFrontmatter("---\r\nname: my-skill\r\n---\r\n");
        assert.equal(out.name, "my-skill");
    });
});
