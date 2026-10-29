import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
// @ts-expect-error Build helpers are JavaScript modules.
import { copyPdfJsAssets } from "../../scripts/copyPdfJsAssets.mjs";
// @ts-expect-error Build helpers are JavaScript modules.
import { copyShellParserAssets } from "../../scripts/copyShellParserAssets.mjs";
import { buildTextPdf } from "../tools/pdfFixtures.ts";

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

test("bundled PDF reader finds its font resources without a node_modules directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-pdfjs-"));
    try {
        const outfile = join(dir, "lib", "pdf.mjs");
        await build({
            entryPoints: [fileURLToPath(new URL("../../src/tools/pdfRead.ts", import.meta.url))],
            outfile,
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node22",
            logLevel: "silent",
        });
        copyPdfJsAssets(join(dir, "lib"));
        for (const resource of ["cmaps", "standard_fonts"]) {
            assert.ok(readdirSync(join(dir, "lib", "pdfjs", resource)).length > 0);
        }
        // A document with a text layer, so the run proves the fonts resolved:
        // without the standard-font files the text comes back empty.
        const pdfPath = join(dir, "sample.pdf");
        writeFileSync(pdfPath, buildTextPdf(["bundled pdf text"]));
        // The runner resolves no node_modules: the resources must come from
        // the copy beside the bundle.
        const runner = join(dir, "smoke.mjs");
        writeFileSync(
            runner,
            `import { extractPdfText } from ${JSON.stringify(pathToFileURL(outfile).href)};\nimport { readFileSync } from "node:fs";\nconst bytes = new Uint8Array(readFileSync(${JSON.stringify(pdfPath)}));\nconst result = await extractPdfText(bytes);\nif (!result || !result.text.includes("bundled pdf text")) throw new Error("text not extracted: " + JSON.stringify(result));\nconsole.log("ok");`,
        );
        const child = spawnSync(process.execPath, [runner], {
            cwd: dir,
            encoding: "utf8",
            env: { ...process.env, TACO_SIDECAR_RESOURCES: join(dir, "lib") },
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("desktop bundle ships the whole sidecar lib directory, grammars included", () => {
    const conf = JSON.parse(
        readFileSync(
            new URL("../../../../clients/taco-desktop/src-tauri/tauri.conf.json", import.meta.url),
            "utf8",
        ),
    ) as { bundle: { resources: Record<string, string> } };
    // Mapping only lib/index.mjs drops lib/grammars/, and the shell parser then
    // fails closed on every command in the installed app.
    assert.equal(conf.bundle.resources["generated/sidecar/lib"], "sidecar/lib");
});
