/**
 * glob tool — lists files by path pattern.
 * Uses a real file tree to verify pattern matching + safe defaults + .gitignore
 * resolution + truncation.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/tools/glob.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createGlobTool } from "../../src/tools/glob.ts";

describe("glob tool", () => {
    let dir: string;
    let env: NodeExecutionEnv;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-glob-"));
        env = new NodeExecutionEnv({ cwd: dir });
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "node_modules"));
        mkdirSync(join(dir, "secrets"));
        writeFileSync(join(dir, "src", "a.ts"), "a");
        writeFileSync(join(dir, "src", "b.ts"), "b");
        writeFileSync(join(dir, "src", "c.js"), "c");
        // Only ignores `secrets/`, not `node_modules`.
        // This distinguishes "safe defaults suppress node_modules" from ".gitignore suppresses secrets/".
        writeFileSync(join(dir, ".gitignore"), "secrets/\n");
        writeFileSync(join(dir, "node_modules", "dep.ts"), "dep");
        writeFileSync(join(dir, "secrets", "k.ts"), "k");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("matches by pattern and returns relative paths", async () => {
        const tool = createGlobTool();
        const res = await tool.execute("tc", { pattern: "src/**/*.ts" }, undefined, undefined, {
            env,
        });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts"));
        assert.ok(text.includes("src/b.ts"));
        assert.ok(!text.includes("c.js"));
    });

    it("respects safe defaults even without .gitignore mention", async () => {
        const tool = createGlobTool();
        const res = await tool.execute("tc", { pattern: "**/*.ts" }, undefined, undefined, { env });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"), "should exclude node_modules via safe defaults");
    });

    it("respects .gitignore user-ignored paths", async () => {
        const tool = createGlobTool();
        const res = await tool.execute("tc", { pattern: "**/*.ts" }, undefined, undefined, { env });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"), "should respect .gitignore 'secrets/' entry");
    });
});
