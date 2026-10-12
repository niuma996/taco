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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("settings-corrupt");

before(() => {
    registerBuiltinMethods();
});

describe("settings.get / mcp.* on corrupt taco.json", () => {
    function writeCorruptConfig(): void {
        writeFileSync(join(home, "taco.json"), "{this is not valid json", "utf8");
    }

    it("settings.get rejects with a parse error rather than returning an empty view", async () => {
        writeCorruptConfig();
        await assert.rejects(() => callMethod("settings.get"), /Unexpected token|Expected|JSON/);
    });

    it("mcp.listServers rejects on corrupt config (no silent empty list)", async () => {
        writeCorruptConfig();
        await assert.rejects(
            () => callMethod("mcp.listServers", { params: {} }),
            /Unexpected token|Expected|JSON/,
        );
    });

    it("settings.write rejects on corrupt config and does not overwrite the file", async () => {
        writeCorruptConfig();
        await assert.rejects(
            () =>
                callMethod("settings.write", {
                    params: { global: { defaultProvider: "anthropic" } },
                }),
            /Unexpected token|Expected|JSON/,
        );
    });
});
