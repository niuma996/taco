/**
 * Built-in OfficeCLI extension. Allow-lists shell invocations of the
 * `officecli` binary so the Office-document workflow taught by the bundled
 * `officecli` skill (skills/builtin/officecli/SKILL.md) does not stall on a
 * permission prompt for every `add` / `set` / `view` / `query`.
 *
 * The rule is in-memory only — it never lands in taco.json — so disabling this
 * extension removes exactly the prompt-bypass and nothing else.
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
        "Built-in. Disable via `disabledExtensions` in ~/.taco/taco.json to restore a permission prompt for every officecli command. The bundled officecli skill stays available either way — only the prompt-bypass is removed.",
    activator: buildOfficeCliActivator,
};
