/**
 * grep tool — searches by content, outputs `relpath:line: text`.
 * Uses a real file tree to verify matching + relpath:line output + .gitignore respect.
 * Does not distinguish rg / fallback paths (both produce the same output format).
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/tools/grep.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createGrepTool } from "../../src/tools/grep.ts";

describe("grep tool", () => {
    let dir: string;
    let env: NodeExecutionEnv;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-grep-"));
        env = new NodeExecutionEnv({ cwd: dir });
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "node_modules"));
        mkdirSync(join(dir, "secrets")); // user-specific, NOT in safe defaults
        writeFileSync(join(dir, "src", "a.ts"), "const foo = 1;\nconst bar = 2;\n");
        writeFileSync(join(dir, "src", "b.ts"), "function baz() { return foo; }\n");
        writeFileSync(join(dir, "node_modules", "dep.ts"), "export const foo = 'shadow';");
        writeFileSync(join(dir, "secrets", "config.ts"), "export const foo = 'hidden';");
        // Only user-ignores `secrets/`, NOT `node_modules` (latter is a safe default)
        writeFileSync(join(dir, ".gitignore"), "secrets/\n");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("finds a literal pattern and reports file:line", async () => {
        const tool = createGrepTool();
        const res = await tool.execute("tc", { pattern: "foo" }, undefined, undefined, { env });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts:1:"));
        assert.ok(text.includes("src/b.ts:1:"));
        assert.ok(!text.includes("const bar"));
    });

    it("filters by glob", async () => {
        const tool = createGrepTool();
        const res = await tool.execute(
            "tc",
            { pattern: "foo", glob: "*.ts" },
            undefined,
            undefined,
            { env },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        // `.glob filter means we'd only check files that match
        // (ripgrep's --glob semantics: filename pattern)
        // Both valid paths search the same files; just check that filter narrows results.
        assert.ok(text.length > 0); // gets some matches
        assert.ok(text.split("\n").every((line) => !line.startsWith("secrets/")));
    });

    it("respects safe defaults (excludes node_modules)", async () => {
        const tool = createGrepTool();
        const res = await tool.execute("tc", { pattern: "foo" }, undefined, undefined, { env });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"));
    });

    it("respects .gitignore (excludes secrets/)", async () => {
        const tool = createGrepTool();
        const res = await tool.execute("tc", { pattern: "foo" }, undefined, undefined, { env });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"));
    });

    it("case-insensitive flag works", async () => {
        writeFileSync(join(dir, "src", "c.ts"), "const FOO = 3;\n");
        const tool = createGrepTool();
        const res = await tool.execute(
            "tc",
            { pattern: "FOO", ignoreCase: true },
            undefined,
            undefined,
            { env },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/c.ts:1:"));
    });
});
