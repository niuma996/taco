/**
 * officeCli builtin extension tests.
 *
 * Guards the contract this extension adds to the shell-permission path and the
 * skill scan:
 *   - the activator contributes `officecli *` for any workspace
 *   - `WorkspaceExtensionSet` collects + dedupes contributed rules
 *   - a command matching the rule evaluates to `allow`; unrelated commands
 *     still fall through to `ask`
 *   - disabling the extension removes both the rule AND the bundled skill dir,
 *     so the bundled skill stops being scanned while a user's own copy (in a
 *     user dir) is untouched.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extensionSkillDirInputs } from "../../../src/config/config.ts";
import { activateExtensions, WorkspaceExtensionSet } from "../../../src/extensions/activation.ts";
import { manifest as officeCliManifest } from "../../../src/extensions/builtin/officeCli/index.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "../../../src/extensions/registry.ts";
import { harnessContext } from "../../../src/lib/harnessContext.ts";
import { evaluateCommand } from "../../../src/permissions/commandPolicy.ts";
import { loadSourcedSkills } from "../../../src/runtime/pi/values.ts";
import { SlashNormalizedExecutionEnv } from "../../../src/runtime/slashNormalizedEnv.ts";
import type { TacoSkill } from "../../../src/skills/tacoSkill.ts";

const OFFICECLI_RULE = "officecli *";
const SKILL_DIR = "extensions/builtin/officeCli/skills";

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

describe("officeCli extension — bundled skill dir", () => {
    let tmpCwd: string;

    before(() => {
        tmpCwd = mkdtempSync(join(tmpdir(), "taco-officecli-skill-"));
    });

    after(() => {
        rmSync(tmpCwd, { recursive: true, force: true });
    });

    /** Scan only the extension-declared dirs, with the extension enabled or not. */
    async function scanForSkill(disabled: ReadonlySet<string>): Promise<TacoSkill[]> {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, disabled, [officeCliManifest]);
        const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
            new SlashNormalizedExecutionEnv({ cwd: tmpCwd }),
            extensionSkillDirInputs(registry.extensionSkillDirs()),
            (skill, source): TacoSkill => ({ ...skill, source }),
            harnessContext,
        );
        return loaded.skills.map((entry) => entry.skill).filter((s) => s.name === "officecli");
    }

    it("declares the skill dir relative to resourceRoot()", () => {
        assert.deepEqual(officeCliManifest.skillDirs, [SKILL_DIR]);
    });

    it("enabled: the bundled skill is scanned from the extension dir", async () => {
        const found = await scanForSkill(new Set());
        assert.equal(found.length, 1, "expected exactly one officecli skill");
        assert.equal(found[0]?.source, "builtin");
        assert.ok(
            found[0]?.filePath.includes(`${SKILL_DIR}/officecli/SKILL.md`),
            `filePath should resolve under the extension dir, got ${found[0]?.filePath}`,
        );
    });

    it("disabled: the bundled skill is not scanned", async () => {
        assert.deepEqual(await scanForSkill(new Set([officeCliManifest.name])), []);
    });
});
