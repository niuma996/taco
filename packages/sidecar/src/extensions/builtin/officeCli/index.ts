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
 * The command allow-rule follows the independent autoApprove setting.
 */
export function buildOfficeCliActivator(): WorkspaceActivator {
    return (ctx): WorkspaceContribution => ({
        commandPermissionRules: ctx.config.autoApprove === false ? [] : [OFFICECLI_RULE],
    });
}

/** Builtin manifest — contributes the officecli shell allow-rule per workspace. */
export const manifest: BuiltinManifest = {
    name: BUILTIN_NAME,
    version: "0.2.0",
    description:
        "Provides the bundled OfficeCLI skill and optional command auto-approval for creating and editing .docx/.xlsx/.pptx files.",
    whenToUse:
        "Use for Office document workflows. Bundled skill and command auto-approval can be configured independently.",
    activator: buildOfficeCliActivator,
    configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            bundledSkill: {
                type: "boolean",
                default: true,
                title: "Bundled OfficeCLI skill",
                description: "Include instructions for creating and editing Office documents.",
                "x-i18n": {
                    zh: {
                        title: "内置 OfficeCLI 技能",
                        description: "加载创建和编辑 Office 文档的操作指引。",
                    },
                },
            },
            autoApprove: {
                type: "boolean",
                default: true,
                title: "Automatically allow OfficeCLI commands",
                description:
                    "Skip per-command approval for officecli. Turn off to keep the skill while reviewing commands individually.",
                "x-i18n": {
                    zh: {
                        title: "自动放行 OfficeCLI 命令",
                        description:
                            "执行 officecli 时免逐次审批；关闭后仍可保留技能并逐次审核命令。",
                    },
                },
            },
        },
    },
    skillDirs: (config) => (config.bundledSkill === false ? [] : [SKILL_DIR]),
};
