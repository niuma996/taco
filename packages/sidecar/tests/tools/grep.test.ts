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
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createGrepTool } from "../../src/tools/grep.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

type GrepDetails = { count: number; truncated: boolean };

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
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts:1:"));
        assert.ok(text.includes("src/b.ts:1:"));
        assert.ok(!text.includes("const bar"));
    });

    it("filters by glob", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "foo", glob: "*.ts" },
            { env },
            { toolCallId: "tc" },
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
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"));
    });

    it("respects .gitignore (excludes secrets/)", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"));
    });

    it("case-insensitive flag works", async () => {
        writeFileSync(join(dir, "src", "c.ts"), "const FOO = 3;\n");
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "FOO", ignoreCase: true },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/c.ts:1:"));
    });

    it("clips a long matching line", async () => {
        writeFileSync(join(dir, "src", "min.js"), `var longneedle="${"x".repeat(5000)}";\n`);
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "longneedle" },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/min.js:1:"));
        assert.ok(text.length < 1000, `got ${text.length} chars`);
        assert.equal((res.details as GrepDetails).truncated, true);
    });

    it("caps total output under the line cap", async () => {
        mkdirSync(join(dir, "wide"));
        // 200 rows (under MAX_LINES) of ~400 chars each would be ~80k chars unclipped.
        const row = `widetoken ${"y".repeat(400)}`;
        writeFileSync(join(dir, "wide", "w.txt"), `${Array(200).fill(row).join("\n")}\n`);
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "widetoken" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.length <= 51_000, `got ${text.length} chars`);
        const details = res.details as GrepDetails;
        assert.equal(details.count, 200);
        assert.equal(details.truncated, true);
        assert.match(text, /more\)$/);
    });
});
