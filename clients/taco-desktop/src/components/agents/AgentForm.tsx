/**
 * AgentForm — create or edit a user agent definition under $TACO_HOME/agents.
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
import type { AgentRuntime, ClaudeCodePermissionMode } from "@taco-ai/protocol";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** Claude Code tool names, as the sidecar validates them. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

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

/** What the form produces; the pane adds `previousAgentType`. */
export interface AgentFormValue {
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    systemPrompt: string;
    tools?: string[];
    permissionMode?: ClaudeCodePermissionMode;
}

export interface AgentFormProps {
    /** Which dialog to show. Edit mode passes the existing definition's runtime. */
    runtime: AgentRuntime;
    /** Edit mode: prefill from the existing definition. Undefined = create. */
    existing?: AgentFormValue;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
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

    const [agentType, setAgentType] = useState(props.existing?.agentType ?? "");
    const [description, setDescription] = useState(props.existing?.description ?? "");
    const [whenToUse, setWhenToUse] = useState(props.existing?.whenToUse ?? "");
    const [maxTurns, setMaxTurns] = useState(
        String(props.existing?.maxTurns ?? defaultMaxTurns(props.runtime)),
    );
    const [systemPrompt, setSystemPrompt] = useState(props.existing?.systemPrompt ?? "");
    const [tools, setTools] = useState(props.existing?.tools?.join(", ") ?? "");
    const [permissionMode, setPermissionMode] = useState<ClaudeCodePermissionMode>(
        props.existing?.permissionMode ?? "auto",
    );

    const trimmedType = agentType.trim();
    const typeValid = AGENT_TYPE_PATTERN.test(trimmedType);
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
        systemPrompt.trim() !== "" &&
        systemPrompt.trim().length <= 65536 &&
        (!isCc || toolsError === undefined);

    const save = () => {
        if (!canSave) return;
        props.onSave({
            agentType: trimmedType,
            description: description.trim(),
            whenToUse: whenToUse.trim() === "" ? undefined : whenToUse.trim(),
            runtime: props.runtime,
            maxTurns: turns,
            systemPrompt,
            ...(isCc ? { tools: toolList, permissionMode } : {}),
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
            {props.error ? <div className="error-banner">{props.error}</div> : null}
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
            <FormField label={t("agents.form.systemPrompt")}>
                <Textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={12}
                    maxLength={65536}
                />
            </FormField>
        </Modal>
    );
}
