import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { saveGlobalConfig } from "../../src/config/config.ts";
import { tacoHome } from "../../src/config/tacoHome.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("im-policy-global-rules");

function serverWithExtensionRule(rule: string): SidecarServer {
    const extensionRegistry = new ExtensionRegistry();
    extensionRegistry.addWorkspaceActivator("builtin", "@taco/test-ext", () => ({
        commandPermissionRules: [rule],
    }));
    return new SidecarServer({ providerKeyStore: new ProviderKeyStore({}), extensionRegistry });
}

describe("imPolicy.get global rule group", () => {
    it("includes extension allow-rules the runtime broker appends", async () => {
        saveGlobalConfig({ commandPermissions: { mode: "ask", allow: ["ls"], deny: ["rm *"] } });
        const result = await serverWithExtensionRule("officecli *").imPolicy.get({
            channelId: "wechat",
        });
        assert.deepEqual(result.rules.allow[0], {
            source: "global",
            rules: ["ls", "officecli *"],
            editable: false,
        });
        assert.deepEqual(result.rules.deny[0], {
            source: "global",
            rules: ["rm *"],
            editable: false,
        });
    });

    it("still loads the editor when taco.json commandPermissions is malformed", async () => {
        writeFileSync(
            join(tacoHome(), "taco.json"),
            JSON.stringify({ commandPermissions: { allow: "not-an-array" } }),
        );
        // A no-op save drops the in-process config cache so the hand edit is read.
        saveGlobalConfig({});
        const result = await serverWithExtensionRule("officecli *").imPolicy.get({
            channelId: "wechat",
        });
        assert.deepEqual(result.rules.allow[0]?.rules, ["officecli *"]);
        assert.deepEqual(result.rules.deny, [{ source: "channel", rules: [], editable: true }]);
    });
});
