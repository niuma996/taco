import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { saveGlobalConfig } from "../../../src/config/config.ts";
import { ExtensionRegistry } from "../../../src/extensions/registry.ts";
import { registerExtensionsHandlers } from "../../../src/server/handlers/extensions.ts";
import { toView } from "../../../src/server/handlers/settings.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("extensions.status", () => {
    const home = useTempTacoHome();
    before(() => registerExtensionsHandlers());
    beforeEach(() => writeFileSync(join(home, "taco.json"), "{}"));

    it("separates actual loaded state from pending disable and configuration changes", async () => {
        void home;
        const registry = new ExtensionRegistry();
        registry.captureConfiguration(new Set(), { alpha: { value: 1 } });
        registry.addTool("alpha", { name: "alphaTool" } as never);
        registry.recordLoaded({
            name: "alpha",
            version: "1.0.0",
            source: "external",
            permissions: ["tools"],
            configSchema: { type: "object" },
        });
        saveGlobalConfig({
            disabledExtensions: ["alpha"],
            extensionConfig: { alpha: { value: 2 }, secret: "not-returned" },
        });

        const result = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: registry },
            params: {},
        });
        assert.deepEqual(
            result.loaded.map((entry) => entry.name),
            ["alpha"],
        );
        assert.deepEqual(result.disabled, []);
        assert.deepEqual(result.pendingRestart.loadedButDisabled, ["alpha"]);
        assert.deepEqual(result.pendingRestart.configuration.sort(), ["alpha", "secret"]);
        assert.deepEqual(result.loaded[0]?.contributions.tools, ["alphaTool"]);
        assert.deepEqual(result.loaded[0]?.configSchema, { type: "object" });
        assert.equal(JSON.stringify(result).includes("not-returned"), false);
        assert.equal(
            Object.hasOwn(
                toView({ extensionConfig: { alpha: { secret: "hidden" } } }),
                "extensionConfig",
            ),
            false,
        );
    });

    it("reports pending enable and load failure without changing actual state", async () => {
        const disabledRegistry = new ExtensionRegistry();
        disabledRegistry.captureConfiguration(new Set(["disabled-ext"]), {});
        disabledRegistry.recordDisabled("disabled-ext", {
            version: "1.0.0",
            source: "external",
            configSchema: { type: "object" },
        });
        saveGlobalConfig({ disabledExtensions: [], extensionConfig: {} });
        const disabled = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: disabledRegistry },
            params: {},
        });
        assert.deepEqual(disabled.disabled, ["disabled-ext"]);
        assert.equal(disabled.disabledEntries[0]?.version, "1.0.0");
        assert.deepEqual(disabled.pendingRestart.disabledButEnabled, ["disabled-ext"]);

        const failedRegistry = new ExtensionRegistry();
        failedRegistry.captureConfiguration(new Set(), {});
        failedRegistry.recordFailed("failed-ext", "bad config");
        const failed = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: failedRegistry },
            params: {},
        });
        assert.deepEqual(failed.pendingRestart.failed, []);
        saveGlobalConfig({ extensionConfig: { "failed-ext": { fixed: true } } });
        const changed = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: failedRegistry },
            params: {},
        });
        assert.deepEqual(changed.pendingRestart.failed, ["failed-ext"]);
    });
    it("reports npm allowlist additions and removals requiring restart", async () => {
        const registry = new ExtensionRegistry();
        const start = ["old-package"];
        registry.captureConfiguration(new Set(), {}, start);
        saveGlobalConfig({ extensions: ["new-package"] });
        const result = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: registry },
            params: {},
        });
        assert.deepEqual(result.pendingRestart.configuration.sort(), [
            "new-package",
            "old-package",
        ]);
        saveGlobalConfig({ extensions: start });
        const restored = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: registry },
            params: {},
        });
        assert.deepEqual(restored.pendingRestart.configuration, []);
    });

    it("keeps runtime diagnostics available when config JSON is invalid", async () => {
        const registry = new ExtensionRegistry();
        registry.recordFailed("broken", "import failed");
        writeFileSync(join(home, "taco.json"), "{ invalid JSON");
        const result = await callMethod<ExtensionsStatusResult>("extensions.status", {
            server: { extensionRegistry: registry },
            params: {},
        });
        assert.equal(result.failed[0]?.reason, "import failed");
        assert.ok(Object.values(result.pendingRestart).every((names) => names.length === 0));
        writeFileSync(join(home, "taco.json"), "{}");
    });
});
