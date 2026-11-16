import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { ExtensionRegistry } from "../../../src/extensions/registry.ts";
import { registerExtensionsHandlers } from "../../../src/server/handlers/extensions.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

const schema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 0, maximum: 10 },
        token: { type: "string", writeOnly: true },
        mode: { type: "string", enum: ["one", "two"] },
        nested: { type: "object" },
        locked: { type: "string", readOnly: true },
    },
};
function server() {
    const registry = new ExtensionRegistry();
    registry.registerConfigSchema("example", schema);
    registry.recordDisabled("example", { configSchema: schema });
    return { extensionRegistry: registry };
}

describe("extension configuration RPCs", () => {
    const home = useTempTacoHome();
    before(registerExtensionsHandlers);
    beforeEach(() => writeFileSync(join(home, "taco.json"), "{}"));

    it("returns only declared simple fields and configured secret markers", async () => {
        saveGlobalConfig({
            extensionConfig: {
                example: {
                    enabled: false,
                    token: "private-token",
                    nested: { secret: "private-nested" },
                    unknown: "private-unknown",
                },
            },
        });
        const result = await callMethod<{
            values: Record<string, unknown>;
            configuredSecrets: string[];
        }>("extensions.configGet", { server: server(), params: { name: "example" } });
        assert.deepEqual({ ...result.values }, { enabled: false });
        assert.deepEqual(result.configuredSecrets, ["token"]);
        assert.ok(!JSON.stringify(result).includes("private-"));
    });

    it("patches one plugin against current disk state while preserving secrets and complex fields", async () => {
        saveGlobalConfig({
            extensionConfig: {
                example: { token: "private", nested: { keep: true }, enabled: false },
                other: { keep: 1 },
            },
        });
        await callMethod("extensions.configUpdate", {
            server: server(),
            params: { name: "example", values: { limit: 3 }, unset: ["enabled"] },
        });
        assert.deepEqual(readGlobalConfig().extensionConfig, {
            example: { token: "private", nested: { keep: true }, limit: 3 },
            other: { keep: 1 },
        });
    });

    it("rejects invalid or unsupported changes before writing", async () => {
        const s = server();
        for (const values of [
            { limit: -1 },
            { mode: "invalid" },
            { nested: {} },
            { unknown: 2 },
            { locked: "no" },
        ]) {
            await assert.rejects(
                callMethod("extensions.configUpdate", {
                    server: s,
                    params: { name: "example", values },
                }),
            );
        }
        assert.equal(readGlobalConfig().extensionConfig, undefined);
    });

    it("supports replacing and explicitly clearing secrets without returning plaintext", async () => {
        const s = server();
        const result = await callMethod("extensions.configUpdate", {
            server: s,
            params: { name: "example", values: { token: "new-private-value" } },
        });
        assert.ok(!JSON.stringify(result).includes("new-private-value"));
        await callMethod("extensions.configUpdate", {
            server: s,
            params: { name: "example", values: {}, unset: ["token"] },
        });
        assert.deepEqual(readGlobalConfig().extensionConfig?.example, {});
    });

    it("repairs schema-invalid saved configuration for an unloaded plugin", async () => {
        saveGlobalConfig({ extensionConfig: { example: { limit: -1 } } });
        const s = server();
        s.extensionRegistry.recordFailed("example", "invalid extension config");
        await callMethod("extensions.configUpdate", {
            server: s,
            params: { name: "example", values: { limit: 2 } },
        });
        assert.deepEqual(readGlobalConfig().extensionConfig?.example, { limit: 2 });
    });
    it("compares saved settings with startup values without mutating running configuration", async () => {
        const s = server();
        s.extensionRegistry.captureConfiguration(new Set(), { example: { enabled: true } });
        saveGlobalConfig({ extensionConfig: { example: { enabled: true } } });
        const result = await callMethod<{ pendingRestart: boolean }>("extensions.configUpdate", {
            server: s,
            params: { name: "example", values: { enabled: false } },
        });
        assert.equal(result.pendingRestart, true);
        assert.deepEqual(s.extensionRegistry.configurationSnapshot().values, {
            example: { enabled: true },
        });
        const restored = await callMethod<{ pendingRestart: boolean }>("extensions.configUpdate", {
            server: s,
            params: { name: "example", values: { enabled: true } },
        });
        assert.equal(restored.pendingRestart, false);
    });
});
