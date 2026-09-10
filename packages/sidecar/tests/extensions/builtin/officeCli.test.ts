/**
 * officeCli builtin extension tests.
 *
 * Guards the contract this extension adds to the shell-permission path:
 *   - the activator contributes `officecli *` for any workspace
 *   - `WorkspaceExtensionSet` collects + dedupes contributed rules
 *   - a command matching the rule evaluates to `allow`; unrelated commands
 *     still fall through to `ask`
 *   - disabling the extension removes the rule
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { activateExtensions, WorkspaceExtensionSet } from "../../../src/extensions/activation.ts";
import { manifest as officeCliManifest } from "../../../src/extensions/builtin/officeCli/index.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "../../../src/extensions/registry.ts";
import { evaluateCommand } from "../../../src/permissions/commandPolicy.ts";

const OFFICECLI_RULE = "officecli *";

describe("officeCli extension — activator", () => {
    it("contributes the officecli allow-rule for any cwd", async () => {
        const activator = await officeCliManifest.activator?.();
        assert.ok(activator, "manifest must declare an activator");
        const contribution = await activator({ cwd: "/nonexistent" });
        assert.deepEqual(contribution?.commandPermissionRules, [OFFICECLI_RULE]);
    });
});

describe("WorkspaceExtensionSet — commandPermissionRules", () => {
    it("collects contributed rules and dedupes repeats", () => {
        const set = new WorkspaceExtensionSet();
        set.addContribution("builtin", { commandPermissionRules: [OFFICECLI_RULE] });
        set.addContribution("builtin", { commandPermissionRules: [OFFICECLI_RULE, "mmx *"] });
        assert.deepEqual(set.commandPermissionRules(), [OFFICECLI_RULE, "mmx *"]);
    });

    it("returns an empty list when no contribution carries rules", () => {
        const set = new WorkspaceExtensionSet();
        set.addContribution("builtin", { contextHooks: [] });
        assert.deepEqual(set.commandPermissionRules(), []);
    });
});

describe("officeCli extension — end-to-end through the registry", () => {
    it("activation collects the rule contributed by the real builtin", async () => {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set(), [officeCliManifest]);
        const set = await activateExtensions(registry, { cwd: "/tmp" });
        assert.deepEqual(set.commandPermissionRules(), [OFFICECLI_RULE]);
    });

    it("disabling the extension drops its rule", async () => {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set([officeCliManifest.name]), [
            officeCliManifest,
        ]);
        const set = await activateExtensions(registry, { cwd: "/tmp" });
        assert.deepEqual(set.commandPermissionRules(), []);
    });
});

describe("officeCli extension — evaluation", () => {
    it("allows an officecli command and still asks for unrelated ones", () => {
        const config = { mode: "ask" as const, rules: [OFFICECLI_RULE] };
        assert.equal(
            evaluateCommand("officecli set deck.pptx / --prop text=hi", config).behavior,
            "allow",
        );
        assert.equal(evaluateCommand("rm -rf build", config).behavior, "ask");
    });
});
