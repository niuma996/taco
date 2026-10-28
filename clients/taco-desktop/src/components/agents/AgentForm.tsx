/**
 * AgentForm — create or edit a user agent definition, stored globally
 * ($TACO_HOME/agents) or in the current workspace (<workspace>/.taco/agents).
 *
 * One dialog per runtime, picked when the agent is created and fixed after:
 * a taco agent and a Claude Code agent share almost no settings beyond the
 * name and prompt, so switching between them mid-edit would only hide fields.
 *
 * - standard: taco's own harness; inherits the parent's toolset (no tools
 *   picker yet, same as a hand-written md file without a `tools:` line).
 * - claude-code: Claude Code's tools and permission system. Empty tools =
 *   its full preset; permission mode defaults to `auto`.
 *
 * The model never sees the runtime — it delegates by agent name only.
 */
import {
    AGENT_TOOL_NAME_PATTERN,
    AGENT_TYPE_PATTERN,
    type AgentRuntime,
    type AgentScope,
    type ClaudeCodePermissionMode,
} from "@taco-ai/protocol";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

/** Claude Code tool names, as the sidecar validates them. */
const TOOL_NAME_PATTERN = AGENT_TOOL_NAME_PATTERN;

/** Never available to a subagent: it would open a prompt no one can answer. */
const BLOCKED_CC_TOOLS = new Set(["AskUserQuestion"]);

/** Turn cap a new definition starts with; Claude Code matches the sidecar's runner default. */
export function defaultMaxTurns(runtime: AgentRuntime): number {
    return runtime === "claude-code" ? 50 : 30;
}

const PERMISSION_MODES: ReadonlyArray<ClaudeCodePermissionMode> = [
    "auto",
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
    "inherit",
];

const SCOPES: ReadonlyArray<AgentScope> = ["global", "workspace"];

/** What the form produces; the pane adds `previousAgentType`. */
export interface AgentFormValue {
    scope: AgentScope;
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    systemPrompt: string;
    tools?: string[];
    permissionMode?: ClaudeCodePermissionMode;
    /** `claude-code` only: the directory it runs in. */
    cwd?: string;
}

export interface AgentFormProps {
    /** Which dialog to show. Edit mode passes the existing definition's runtime. */
    runtime: AgentRuntime;
    /** Edit mode: prefill from the existing definition. Undefined = create. */
    existing?: AgentFormValue;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
    /** False for IM conversations, which have no project directory to hold a workspace-scoped agent. */
    hasProjectDir: boolean;
    /** Names of global agents; saving a workspace agent under one of them shadows it. */
    shadowedTypes: ReadonlyArray<string>;
    /**
     * Directories a Claude Code agent may run in: the workspace's own first
     * (the default for a new agent, and for one saved before the field
     * existed), then its associated directories.
     */
    cwdChoices: ReadonlyArray<string>;
    /** Save errors (RPC-level) are shown in the form so the draft survives. */
    error?: string | null;
    onSave: (value: AgentFormValue) => void;
    onCancel: () => void;
}

/** Comma/whitespace separated tool names → list; empty input = undefined (preset). */
function parseTools(raw: string): string[] | undefined {
    const names = raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    return names.length > 0 ? names : undefined;
}

export function AgentForm(props: AgentFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;
    const isCc = props.runtime === "claude-code";

    const [scope, setScope] = useState<AgentScope>(props.existing?.scope ?? "global");
    const [agentType, setAgentType] = useState(props.existing?.agentType ?? "");
    const [description, setDescription] = useState(props.existing?.description ?? "");
    const [whenToUse, setWhenToUse] = useState(props.existing?.whenToUse ?? "");
    const [maxTurns, setMaxTurns] = useState(
        String(props.existing?.maxTurns ?? defaultMaxTurns(props.runtime)),
    );
    const [systemPrompt, setSystemPrompt] = useState(props.existing?.systemPrompt ?? "");
    // Off by default and only reachable by flipping it: an empty md body is a
    // valid definition (no role contributor is appended to the child's
    // prompt), so this switch buys no new capability — it makes the choice
    // explicit instead of letting a forgotten field silently produce a
    // role-less agent. A create form has nothing to inherit, so it starts off
    // regardless — hence the explicit guard rather than an optional chain.
    const [noRolePrompt, setNoRolePrompt] = useState(
        props.existing !== undefined && props.existing.systemPrompt.trim() === "",
    );
    const [tools, setTools] = useState(props.existing?.tools?.join(", ") ?? "");
    const [permissionMode, setPermissionMode] = useState<ClaudeCodePermissionMode>(
        props.existing?.permissionMode ?? "auto",
    );
    // Shown and saved even when the definition has none: an agent saved before
    // this field existed already runs in the workspace directory, so that is
    // what the picker states, and saving makes it explicit.
    const [cwd, setCwd] = useState<string>(props.existing?.cwd ?? props.cwdChoices[0] ?? "");
    // A directory saved from another workspace is kept as a choice so editing
    // other fields here does not silently move the agent.
    const cwdOptions =
        cwd !== "" && !props.cwdChoices.includes(cwd)
            ? [cwd, ...props.cwdChoices]
            : props.cwdChoices;

    const trimmedType = agentType.trim();
    const typeValid = AGENT_TYPE_PATTERN.test(trimmedType);
    // Moving a global agent to the workspace under its own name is a move, not a shadow.
    const shadowsGlobal =
        scope === "workspace" &&
        trimmedType !== props.existing?.agentType &&
        props.shadowedTypes.includes(trimmedType);
    const turns = Number.parseInt(maxTurns.trim(), 10);
    const turnsValid =
        Number.isInteger(turns) && turns >= 1 && turns <= 200 && String(turns) === maxTurns.trim();
    const toolList = parseTools(tools);
    const blockedTool = toolList?.find((n) => BLOCKED_CC_TOOLS.has(n));
    const toolsError =
        blockedTool !== undefined
            ? t("agents.form.ccToolBlocked", { tool: blockedTool })
            : (toolList?.some((n) => !TOOL_NAME_PATTERN.test(n)) ?? false)
              ? t("agents.form.ccToolsInvalid")
              : undefined;
    // Mirrors agentsWriteSchema: `maxLength` on the inputs stops typing, but a
    // value set any other way (e.g. a pre-limit definition) must not reach a
    // write the sidecar rejects.
    const canSave =
        typeValid &&
        description.trim() !== "" &&
        description.trim().length <= 1024 &&
        whenToUse.trim().length <= 2048 &&
        turnsValid &&
        (noRolePrompt || systemPrompt.trim() !== "") &&
        systemPrompt.trim().length <= 65536 &&
        (!isCc || toolsError === undefined);

    const save = () => {
        if (!canSave) return;
        props.onSave({
            scope,
            agentType: trimmedType,
            description: description.trim(),
            whenToUse: whenToUse.trim() === "" ? undefined : whenToUse.trim(),
            runtime: props.runtime,
            maxTurns: turns,
            systemPrompt: noRolePrompt ? "" : systemPrompt,
            ...(isCc ? { tools: toolList, permissionMode, ...(cwd !== "" ? { cwd } : {}) } : {}),
        });
    };

    const title = isCc
        ? isEdit
            ? t("agents.form.editCcTitle")
            : t("agents.form.newCcTitle")
        : isEdit
          ? t("agents.form.editTitle")
          : t("agents.form.newTitle");

    return (
        <Modal
            open
            onClose={props.onCancel}
            title={title}
            className="agent-form-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={props.onCancel} disabled={props.saving}>
                        {t("agents.form.cancel")}
                    </Button>
                    <Button variant="primary" disabled={!canSave || props.saving} onClick={save}>
                        {props.saving ? t("agents.form.saving") : t("agents.form.save")}
                    </Button>
                </>
            }
        >
            {props.error ? (
                <div className="error-banner" role="alert">
                    {props.error}
                </div>
            ) : null}
            {isCc && (
                <div className="agent-form-notice agent-form-notice--warn" role="note">
                    {t("agents.form.ccCwdNotice")}
                </div>
            )}
            {isCc && (
                <ul className="agent-form-rules" aria-label={t("agents.form.ccRulesLabel")}>
                    <li>{t("agents.form.ccRuleEngine")}</li>
                    <li>{t("agents.form.ccRulePermissions")}</li>
                    <li>{t("agents.form.ccRuleContext")}</li>
                    <li>{t("agents.form.ccRuleCheckpoints")}</li>
                    <li>{t("agents.form.ccRuleAskUser")}</li>
                </ul>
            )}
            <FormField
                label={t("agents.form.scope")}
                hint={t(
                    scope === "global"
                        ? "agents.form.scopeGlobalHint"
                        : "agents.form.scopeWorkspaceHint",
                )}
            >
                <Select
                    value={scope}
                    onValueChange={(v) => setScope(v as AgentScope)}
                    options={SCOPES.map((value) => ({
                        value,
                        label: t(`agents.scope.${value}`),
                    }))}
                    disabled={!props.hasProjectDir}
                    label={t("agents.form.scope")}
                />
            </FormField>
            {shadowsGlobal && (
                <div className="agent-form-notice">{t("agents.form.shadowsGlobal")}</div>
            )}
            <FormField
                label={t("agents.form.name")}
                hint={t("agents.form.nameHint")}
                error={trimmedType !== "" && !typeValid ? t("agents.form.nameInvalid") : undefined}
            >
                <TextInput
                    value={agentType}
                    onChange={(e) => setAgentType(e.target.value)}
                    placeholder="code-reviewer"
                />
            </FormField>
            <FormField label={t("agents.form.description")}>
                <TextInput
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={1024}
                />
            </FormField>
            <FormField label={t("agents.form.whenToUse")}>
                <TextInput
                    value={whenToUse}
                    onChange={(e) => setWhenToUse(e.target.value)}
                    maxLength={2048}
                />
            </FormField>
            {isCc && (
                <>
                    <FormField label={t("agents.form.ccCwd")} hint={t("agents.form.ccCwdHint")}>
                        <Select
                            value={cwd}
                            onValueChange={setCwd}
                            options={cwdOptions.map((dir, i) => ({
                                value: dir,
                                label: dir,
                                ...(dir === props.cwdChoices[0] && i === cwdOptions.indexOf(dir)
                                    ? { badge: t("agents.form.ccCwdWorkspace") }
                                    : {}),
                            }))}
                            disabled={cwdOptions.length === 0}
                            label={t("agents.form.ccCwd")}
                        />
                    </FormField>
                    <FormField
                        label={t("agents.form.ccTools")}
                        hint={t("agents.form.ccToolsHint")}
                        error={toolsError}
                    >
                        <TextInput
                            value={tools}
                            onChange={(e) => setTools(e.target.value)}
                            placeholder="Read, Grep, Glob, Edit, Bash"
                        />
                    </FormField>
                    <FormField
                        label={t("agents.form.ccPermissionMode")}
                        hint={t(`agents.form.ccMode.${permissionMode}Hint`)}
                    >
                        <Select
                            value={permissionMode}
                            onValueChange={(v) => setPermissionMode(v as ClaudeCodePermissionMode)}
                            options={PERMISSION_MODES.map((m) => ({
                                value: m,
                                label: t(`agents.form.ccMode.${m}`),
                            }))}
                            label={t("agents.form.ccPermissionMode")}
                        />
                    </FormField>
                    {permissionMode === "bypassPermissions" && (
                        <div className="agent-form-notice agent-form-notice--warn" role="note">
                            {t("agents.form.ccBypassImNotice")}
                        </div>
                    )}
                </>
            )}
            <FormField
                label={t("agents.form.maxTurns")}
                error={!turnsValid ? t("agents.form.maxTurnsInvalid") : undefined}
            >
                <TextInput
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    inputMode="numeric"
                />
            </FormField>
            <FormField
                label={t("agents.form.systemPrompt")}
                hint={t("agents.form.systemPromptHint")}
                action={
                    <span className="agent-form-no-role">
                        <Switch
                            checked={noRolePrompt}
                            onChange={setNoRolePrompt}
                            label={t("agents.form.noRolePrompt")}
                        />
                        {t("agents.form.noRolePrompt")}
                    </span>
                }
            >
                <Textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={12}
                    maxLength={65536}
                    disabled={noRolePrompt}
                />
            </FormField>
        </Modal>
    );
}
