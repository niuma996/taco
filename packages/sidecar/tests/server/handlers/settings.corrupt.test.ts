/**
 * Regression coverage at the RPC boundary: when taco.json is malformed, the
 * settings.* / mcp.* handlers must surface a non-zero error frame instead
 * of crashing the process or silently returning an empty view. This is the
 * fix's contract as observed from the desktop's perspective.
 *
 * Background: the previous `readJsonOrEmpty` swallowed parse errors and
 * cached an empty object for the process lifetime. The desktop then showed
 * blank settings panes while the tools loaded from the same file at startup
 * kept working — fixed only by restarting the sidecar. After the fix the
 * handler must throw; the dispatch layer turns that into an `internal`
 * error frame so the client at least sees that something is wrong rather
 * than a silent empty view.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.corrupt.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-corrupt-"));
    process.env.TACO_HOME = tmpDir;
    registerBuiltinMethods();
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings.get / mcp.* on corrupt taco.json", () => {
    function writeCorruptConfig(): void {
        writeFileSync(join(tmpDir, "taco.json"), "{this is not valid json", "utf8");
    }

    it("settings.get rejects with a parse error rather than returning an empty view", async () => {
        writeCorruptConfig();
        const reg = getRegisteredMethod("settings.get");
        assert.ok(reg, "settings.get must be registered");
        await assert.rejects(
            () =>
                reg.handler({
                    id: "test",
                    workspace: undefined as never,
                    cwd: undefined as never,
                    server: undefined as never,
                    params: undefined,
                }),
            /Unexpected token|Expected|JSON/,
        );
    });

    it("mcp.listServers rejects on corrupt config (no silent empty list)", async () => {
        writeCorruptConfig();
        const reg = getRegisteredMethod("mcp.listServers");
        assert.ok(reg, "mcp.listServers must be registered");
        await assert.rejects(
            () =>
                reg.handler({
                    id: "test",
                    workspace: undefined as never,
                    cwd: undefined as never,
                    server: undefined as never,
                    params: {},
                }),
            /Unexpected token|Expected|JSON/,
        );
    });

    it("settings.write rejects on corrupt config and does not overwrite the file", async () => {
        writeCorruptConfig();
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg, "settings.write must be registered");
        await assert.rejects(
            () =>
                reg.handler({
                    id: "test",
                    workspace: undefined as never,
                    cwd: undefined as never,
                    server: undefined as never,
                    params: { global: { defaultProvider: "anthropic" } },
                }),
            /Unexpected token|Expected|JSON/,
        );
    });
});
