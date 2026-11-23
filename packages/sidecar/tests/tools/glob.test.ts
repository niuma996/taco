import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
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
