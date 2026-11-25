import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext, test } from "node:test";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createGlobTool } from "../../src/tools/glob.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

type GlobResult = { content: Array<{ type: string; text: string }> };

function globResult(value: unknown): GlobResult {
    return value as GlobResult;
}

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "taco-glob-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, env: new NodeExecutionEnv({ cwd: dir }), tool: createGlobTool() };
}

test("lists files under a directory path", async (t) => {
    const { dir, env, tool } = fixture(t);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "");
    const result = globResult(
        await invokeTool(tool, { pattern: "**/*.ts", path: join(dir, "src") }, { env }),
    );
    assert.equal(result.content[0].text, "a.ts");
});

test("rejects a path that does not exist", async (t) => {
    const { dir, env, tool } = fixture(t);
    await assert.rejects(
        invokeTool(tool, { pattern: "**/*.ts", path: join(dir, "missing") }, { env }),
        /path does not exist/,
    );
});

test("resolves a relative path against the env cwd", async (t) => {
    const { dir, env, tool } = fixture(t);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "");
    const result = globResult(await invokeTool(tool, { pattern: "**/*.ts", path: "src" }, { env }));
    assert.equal(result.content[0].text, "a.ts");
});

test("rejects a file path instead of silently matching nothing", async (t) => {
    const { dir, env, tool } = fixture(t);
    writeFileSync(join(dir, "a.ts"), "");
    await assert.rejects(
        invokeTool(tool, { pattern: "*.ts", path: join(dir, "a.ts") }, { env }),
        /must be a directory/,
    );
});

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
        const res = await invokeTool(
            tool,
            { pattern: "src/**/*.ts" },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts"));
        assert.ok(text.includes("src/b.ts"));
        assert.ok(!text.includes("c.js"));
    });

    it("respects safe defaults even without .gitignore mention", async () => {
        const tool = createGlobTool();
        const res = await invokeTool(tool, { pattern: "**/*.ts" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"), "should exclude node_modules via safe defaults");
    });

    it("respects .gitignore user-ignored paths", async () => {
        const tool = createGlobTool();
        const res = await invokeTool(tool, { pattern: "**/*.ts" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"), "should respect .gitignore 'secrets/' entry");
    });
});
