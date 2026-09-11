/**
 * Built-in OfficeCLI extension. Owns the bundled `officecli` skill
 * (skills/officecli/, declared via `skillDirs`) and allow-lists shell
 * invocations of the `officecli` binary, so the Office-document workflow the
 * skill teaches does not stall on a permission prompt for every `add` / `set`
 * / `view` / `query`.
 *
 * Both contributions are gated by this one manifest: disabling the extension
 * stops the skill dir from being scanned AND drops the allow-rule. The rule
 * itself is in-memory only — it never lands in taco.json.
 *
 * Scope is the whole binary (`officecli *`), a deliberate trade-off: officecli
 * only reads/writes paths the caller names, so the blast radius is the
 * documents the workflow touches. Narrowing to read verbs would still prompt on
 * every `set`/`add` — the bulk of the workflow — so it would buy nothing.
 */

import type { BuiltinManifest } from "../../builtinContract.ts";
import type { WorkspaceActivator, WorkspaceContribution } from "../../types.ts";

const BUILTIN_NAME = "@taco/builtin-officecli";

/** Shell allow-rule contributed for every workspace. */
const OFFICECLI_RULE = "officecli *";

/**
 * Bundled skill directory, relative to `resourceRoot()`. Declared here so the
 * skill is scanned only while this extension is enabled — disabling it drops
 * the skill and the allow-rule together, and a user's own officecli skill
 * (installed under ~/.claude/skills) is untouched.
 */
const SKILL_DIR = "extensions/builtin/officeCli/skills";

/**
 * Always contributes the allow-rule — officecli operates only on files the
 * user names, so gating on workspace state (as git-context does) would add a
 * probe with no decision to make.
 */
export function buildOfficeCliActivator(): WorkspaceActivator {
    return (): WorkspaceContribution => ({ commandPermissionRules: [OFFICECLI_RULE] });
}

/** Builtin manifest — contributes the officecli shell allow-rule per workspace. */
export const manifest: BuiltinManifest = {
    name: BUILTIN_NAME,
    description:
        "Allow-lists `officecli` shell invocations so the bundled officecli skill can create and edit .docx/.xlsx/.pptx without a permission prompt per command.",
    whenToUse:
        "Built-in. Disable via `disabledExtensions` in ~/.taco/taco.json to restore a permission prompt for every officecli command and drop the bundled officecli skill. A user-installed officecli skill under ~/.claude/skills is unaffected.",
    activator: buildOfficeCliActivator,
    skillDirs: [SKILL_DIR],
};
