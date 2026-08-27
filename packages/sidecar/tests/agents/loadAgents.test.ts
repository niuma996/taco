/**
 * loadAgents — parses md frontmatter, merges builtin (param dir) + user dirs (same-name overrides).
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/agents/loadAgents.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadAgents, parseAgentMarkdown } from "../../src/agents/loadAgents.ts";

describe("parseAgentMarkdown", () => {
    it("parses frontmatter + body", () => {
        const md =
            "---\nname: explorer\ndescription: read-only\ntools:\n  - read\n  - grep\nmaxTurns: 30\n---\nYou are an explorer.";
        const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
        assert.ok(def, "expected parseAgentMarkdown to return non-null");
        assert.equal(def.agentType, "explorer");
        assert.equal(def.description, "read-only");
        assert.deepEqual(def.tools, ["read", "grep"]);
        assert.equal(def.maxTurns, 30);
        assert.equal(def.systemPrompt, "You are an explorer.");
    });

    it("returns null when name missing", () => {
        const def = parseAgentMarkdown("---\ndescription: x\n---\nbody", "/x/bad.md", "user");
        assert.equal(def, null);
    });

    it("no frontmatter returns null (no agentType)", () => {
        const def = parseAgentMarkdown("just a body, no frontmatter here", "/x/raw.md", "user");
        assert.equal(def, null);
    });

    it("parses fewShots from frontmatter", () => {
        const md = [
            "---",
            "name: explorer",
            "description: x",
            "fewShots:",
            "  - user: where is foo?",
            "    assistant: foo is at src/foo.ts:42.",
            "  - user: |",
            "      multiline user",
            "      request",
            "    assistant: |",
            "      multiline assistant",
            "      answer",
            "---",
            "body",
        ].join("\n");
        const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
        assert.ok(def);
        assert.equal(def.fewShots?.length, 2);
        assert.equal(def.fewShots?.[0].user, "where is foo?");
        assert.equal(def.fewShots?.[0].assistant, "foo is at src/foo.ts:42.");
        assert.equal(def.fewShots?.[1].user, "multiline user\nrequest");
        assert.equal(def.fewShots?.[1].assistant, "multiline assistant\nanswer");
    });

    it("drops fewShots items missing a field", () => {
        const md = [
            "---",
            "name: explorer",
            "description: x",
            "fewShots:",
            "  - user: only user",
            "  - assistant: only assistant",
            "  - user: |",
            "      valid pair",
            "    assistant: |",
            "      with both fields",
            "---",
            "body",
        ].join("\n");
        const def = parseAgentMarkdown(md, "/x/explorer.md", "builtin");
        assert.ok(def);
        // The two malformed items drop out; only the third (valid pair) remains.
        assert.equal(def.fewShots?.length, 1);
        assert.equal(def.fewShots?.[0].user, "valid pair");
    });

    it("omits fewShots when frontmatter key is absent", () => {
        const md = "---\nname: x\ndescription: y\n---\nbody";
        const def = parseAgentMarkdown(md, "/x/x.md", "builtin");
        assert.ok(def);
        assert.equal(def.fewShots, undefined);
    });

    it("parses context from frontmatter", () => {
        const def = parseAgentMarkdown(
            "---\nname: reviewer\ndescription: x\ncontext: fork\n---\nbody",
            "/x/reviewer.md",
            "builtin",
        );
        assert.ok(def);
        assert.equal(def.context, "fork");
    });

    it("omits context when the frontmatter key is absent or invalid", () => {
        const absent = parseAgentMarkdown(
            "---\nname: x\ndescription: y\n---\nbody",
            "/x/x.md",
            "builtin",
        );
        assert.equal(absent?.context, undefined);
        const invalid = parseAgentMarkdown(
            "---\nname: x\ndescription: y\ncontext: bogus\n---\nbody",
            "/x/x.md",
            "builtin",
        );
        assert.equal(invalid?.context, undefined);
    });
});

describe("loadAgents", () => {
    let userDir: string;
    before(() => {
        userDir = mkdtempSync(join(tmpdir(), "taco-agents-"));
    });
    after(() => rmSync(userDir, { recursive: true, force: true }));

    it("loads agents from a given builtin dir", async () => {
        const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
        writeFileSync(
            join(builtinDir, "explorer.md"),
            "---\nname: explorer\ndescription: builtin x\n---\nbuiltin body",
        );
        try {
            const agents = await loadAgents({ builtinDir, userDirs: [userDir] });
            const explorer = agents.find((a) => a.agentType === "explorer");
            assert.ok(explorer, "expected builtin explorer");
            assert.equal(explorer.description, "builtin x");
            assert.equal(explorer.source, "builtin");
        } finally {
            rmSync(builtinDir, { recursive: true, force: true });
        }
    });

    it("user agent overrides builtin of same name", async () => {
        const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
        writeFileSync(
            join(builtinDir, "explorer.md"),
            "---\nname: explorer\ndescription: builtin version\n---\nbody",
        );
        writeFileSync(
            join(userDir, "explorer.md"),
            "---\nname: explorer\ndescription: USER override\n---\ncustom",
        );
        try {
            const agents = await loadAgents({ builtinDir, userDirs: [userDir] });
            const explorer = agents.find((a) => a.agentType === "explorer");
            assert.equal(explorer?.description, "USER override");
            assert.equal(explorer?.source, "user");
        } finally {
            rmSync(builtinDir, { recursive: true, force: true });
        }
    });

    it("missing user dir is silently ignored", async () => {
        const builtinDir = mkdtempSync(join(tmpdir(), "taco-builtin-"));
        writeFileSync(
            join(builtinDir, "explorer.md"),
            "---\nname: explorer\ndescription: x\n---\nbody",
        );
        try {
            const agents = await loadAgents({
                builtinDir,
                userDirs: ["/nonexistent/path/should/not/exist/xyz"],
            });
            assert.ok(agents.find((a) => a.agentType === "explorer"));
        } finally {
            rmSync(builtinDir, { recursive: true, force: true });
        }
    });
});
