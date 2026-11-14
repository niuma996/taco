import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
// @ts-expect-error Build helpers are JavaScript modules.
import { buildCodexBridge } from "../../scripts/buildCodexBridge.mjs";

test("npm build emits the standalone Codex bridge", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const built = spawnSync(process.execPath, ["esbuild.config.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    assert.ok(
        existsSync(new URL("../../lib/codexCommunicationBridge.mjs", import.meta.url)),
        "Codex bridge must ship alongside sidecar.mjs",
    );
});

test("bundled host launches its sibling bridge without node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-codex-bundle-"));
    const lib = join(dir, "lib");
    try {
        buildCodexBridge(lib);
        const hostPath = join(lib, "host.mjs");
        await build({
            entryPoints: [
                fileURLToPath(
                    new URL(
                        "../../src/runtime/subagent/codex/codexCommunication.ts",
                        import.meta.url,
                    ),
                ),
            ],
            outfile: hostPath,
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node22",
            banner: {
                js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
            },
            logLevel: "silent",
        });
        const { createCodexCommunicationBridge } = (await import(
            pathToFileURL(hostPath).href
        )) as typeof import("../../src/runtime/subagent/codex/codexCommunication.ts");
        const bridge = await createCodexCommunicationBridge({
            allowedNames: ["listAgentSessions"],
            list: async () => ["bundled-child"],
            chat: async () => {
                throw new Error("not granted");
            },
        });
        const client = new Client({ name: "bundled-bridge-test", version: "1" });
        try {
            await client.connect(
                new StdioClientTransport({ ...bridge.mcpServer, cwd: dir, stderr: "pipe" }),
            );
            assert.deepEqual(
                (await client.listTools()).tools.map((tool) => tool.name),
                ["listAgentSessions"],
            );
            assert.deepEqual(
                (await client.callTool({ name: "listAgentSessions", arguments: {} })).content,
                [{ type: "text", text: '["bundled-child"]' }],
            );
        } finally {
            await client.close();
            await bridge.close();
        }
        assert.equal(existsSync(join(dir, "node_modules")), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
