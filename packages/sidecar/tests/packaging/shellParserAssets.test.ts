import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
// @ts-expect-error Build helpers are JavaScript modules.
import { copyShellParserAssets } from "../../scripts/copyShellParserAssets.mjs";

test("bundled shell parser loads both grammars without a node_modules directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-shell-parser-"));
    try {
        const outfile = join(dir, "lib", "parser.mjs");
        await build({
            entryPoints: [
                fileURLToPath(new URL("../../src/permissions/shellParser.ts", import.meta.url)),
            ],
            outfile,
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node22",
            logLevel: "silent",
        });
        copyShellParserAssets(join(dir, "lib"));
        for (const asset of [
            "tree-sitter.wasm",
            "tree-sitter-bash.wasm",
            "tree-sitter-powershell.wasm",
            "LICENSE.bash",
            "LICENSE.powershell",
            "LICENSE.web-tree-sitter",
        ]) {
            assert.ok(readFileSync(join(dir, "lib", "grammars", asset)).length > 0);
        }
        const runner = join(dir, "smoke.mjs");
        writeFileSync(
            runner,
            `import { parseShellCommand } from ${JSON.stringify(pathToFileURL(outfile).href)};\nfor (const language of ['bash', 'powershell']) { const result = parseShellCommand('cd "a b" && git diff', language); if (!result.complete || result.nodes.length !== 2) throw new Error(JSON.stringify(result)); }`,
        );
        const child = spawnSync(process.execPath, [runner], { cwd: dir, encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
