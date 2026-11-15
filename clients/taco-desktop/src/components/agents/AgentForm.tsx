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
    type AgentsRuntimeStatusResult,
    type ClaudeCodePermissionMode,
    type CodexApprovalPolicy,
    type CodexSandboxMode,
} from "@taco-ai/protocol";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";
import {
    type AgentFormDraft,
    type AgentFormValue,
    agentDraftToValue,
    agentFormDefaults,
    isExactAgentInteger,
    parseAgentTools,
} from "./agentFormDraft.ts";
import { CodexRuntimeNotice } from "./CodexRuntimeNotice.tsx";

export { type AgentFormValue, defaultMaxTurns } from "./agentFormDraft.ts";

/** Never available to a subagent: it would open a prompt no one can answer. */
const BLOCKED_CC_TOOLS = new Set(["AskUserQuestion"]);

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
const CODEX_SANDBOXES: ReadonlyArray<CodexSandboxMode> = [
    "read-only",
    "workspace-write",
    "danger-full-access",
];
const CODEX_APPROVALS: ReadonlyArray<CodexApprovalPolicy> = [
    "untrusted",
    "on-failure",
    "on-request",
    "never",
];

export interface AgentFormProps {
    /** Which dialog to show. Edit mode passes the existing definition's runtime. */
    runtime: AgentRuntime;
    /** Edit mode: prefill from the existing definition. Undefined = create. */
    existing?: AgentFormValue;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
    /** False for IM conversations, which have no project directory to hold a workspace-scoped agent. */
    hasProjectDir: boolean;
    /** Set by the pane's scope tabs to prevent writes landing in another layer. */
    fixedScope?: AgentScope;
    /** Names of global agents; saving a workspace agent under one of them shadows it. */
    shadowedTypes: ReadonlyArray<string>;
    /**
     * Directories a Claude Code agent may run in: the workspace's own first
     * (the default for a new agent, and for one saved before the field
     * existed), then its associated directories.
     */
    cwdChoices: ReadonlyArray<string>;
    codexRuntimeStatus?: AgentsRuntimeStatusResult | null;
    codexStatusLoading?: boolean;
    codexInstalling?: boolean;
    codexInstallError?: string | null;
    onInstallCodex?: () => void;
    onRefreshCodexRuntime?: () => void;
    /** Save errors (RPC-level) are shown in the form so the draft survives. */
    error?: string | null;
    onSave: (value: AgentFormValue) => void | Promise<void>;
    onCancel: () => void;
}

export function AgentForm(props: AgentFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;
    const isCc = props.runtime === "claude-code";
    const isCodex = props.runtime === "codex";

    const {
        register,
        control,
        watch,
        handleSubmit,
        formState: { isValid, isSubmitting, errors },
    } = useForm<AgentFormDraft>({
        defaultValues: agentFormDefaults(props.existing, props.fixedScope, props.cwdChoices),
        mode: "onChange",
    });
    const [scope, agentType, noRolePrompt, permissionMode, cwd, codexCwd, codexApprovalPolicy] =
        watch([
            "scope",
            "agentType",
            "noRolePrompt",
            "permissionMode",
            "cwd",
            "codexCwd",
            "codexApprovalPolicy",
        ]);
    const submitting = useRef(false);
    const saving = props.saving || isSubmitting;
    const maxTurnsField = register("maxTurns", {
        validate: (value) => isExactAgentInteger(value, 500) || t("agents.form.maxTurnsInvalid"),
    });

    // A directory saved from another workspace is kept as a choice so editing
    // other fields here does not silently move the agent.
    const cwdOptions =
        cwd !== "" && !props.cwdChoices.includes(cwd)
            ? [cwd, ...props.cwdChoices]
            : props.cwdChoices;
    const codexCwdOptions =
        codexCwd !== "" && !props.cwdChoices.includes(codexCwd)
            ? [codexCwd, ...props.cwdChoices]
            : props.cwdChoices;

    const trimmedType = agentType.trim();
    // Moving a global agent to the workspace under its own name is a move, not a shadow.
    const shadowsGlobal =
        scope === "workspace" &&
        trimmedType !== props.existing?.agentType &&
        props.shadowedTypes.includes(trimmedType);
    const save = async () => {
        // isSubmitting disables the next render; the ref also covers two clicks
        // in the same event batch, before validation or onSave has completed.
        if (props.saving || submitting.current) return;
        submitting.current = true;
        try {
            await handleSubmit(async (draft) => {
                await props.onSave(agentDraftToValue(draft, props.runtime, props.existing));
            })();
        } catch {
            // The caller presents RPC failures through props.error. Keep the
            // draft available for retry even when its callback rejects.
        } finally {
            submitting.current = false;
        }
    };

    const title = isCodex
        ? isEdit
            ? t("agents.form.editCodexTitle")
            : t("agents.form.newCodexTitle")
        : isCc
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
                    <Button variant="ghost" onClick={props.onCancel} disabled={saving}>
                        {t("agents.form.cancel")}
                    </Button>
                    <Button variant="primary" disabled={!isValid || saving} onClick={save}>
                        {saving ? t("agents.form.saving") : t("agents.form.save")}
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
            {isCodex && (
                <CodexRuntimeNotice
                    status={props.codexRuntimeStatus}
                    loading={props.codexStatusLoading}
                    installing={props.codexInstalling}
                    error={props.codexInstallError}
                    onInstall={props.onInstallCodex}
                    onRefresh={props.onRefreshCodexRuntime}
                />
            )}
            {props.fixedScope === undefined && (
                <Controller
                    control={control}
                    name="scope"
                    render={({ field }) => (
                        <FormField
                            label={t("agents.form.scope")}
                            hint={t(
                                scope === "global"
                                    ? "agents.form.scopeGlobalHint"
                                    : "agents.form.scopeWorkspaceHint",
                            )}
                        >
                            <Select
                                value={field.value}
                                onValueChange={field.onChange}
                                options={SCOPES.map((value) => ({
                                    value,
                                    label: t(`agents.scope.${value}`),
                                }))}
                                disabled={!props.hasProjectDir}
                                label={t("agents.form.scope")}
                            />
                        </FormField>
                    )}
                />
            )}
            {shadowsGlobal && (
                <div className="agent-form-notice">{t("agents.form.shadowsGlobal")}</div>
            )}
            <div className="agent-form-grid">
                <FormField
                    label={t("agents.form.name")}
                    hint={t("agents.form.nameHint")}
                    error={trimmedType !== "" ? errors.agentType?.message : undefined}
                >
                    <TextInput
                        {...register("agentType", {
                            validate: (value) =>
                                AGENT_TYPE_PATTERN.test(value.trim()) ||
                                t("agents.form.nameInvalid"),
                        })}
                        placeholder="code-reviewer"
                    />
                </FormField>
                <FormField label={t("agents.form.description")}>
                    <TextInput
                        {...register("description", {
                            validate: (value) => value.trim() !== "" && value.trim().length <= 1024,
                        })}
                        maxLength={1024}
                    />
                </FormField>
            </div>
            <FormField label={t("agents.form.whenToUse")}>
                <TextInput
                    {...register("whenToUse", {
                        validate: (value) => value.trim().length <= 2048,
                    })}
                    maxLength={2048}
                />
            </FormField>
            {isCc && (
                <>
                    <Controller
                        control={control}
                        name="cwd"
                        render={({ field }) => (
                            <FormField
                                label={t("agents.form.ccCwd")}
                                hint={t("agents.form.ccCwdHint")}
                            >
                                <Select
                                    value={field.value}
                                    onValueChange={field.onChange}
                                    options={cwdOptions.map((dir, i) => ({
                                        value: dir,
                                        label: dir,
                                        ...(dir === props.cwdChoices[0] &&
                                        i === cwdOptions.indexOf(dir)
                                            ? { badge: t("agents.form.ccCwdWorkspace") }
                                            : {}),
                                    }))}
                                    disabled={cwdOptions.length === 0}
                                    label={t("agents.form.ccCwd")}
                                />
                            </FormField>
                        )}
                    />
                    <FormField
                        label={t("agents.form.ccTools")}
                        hint={t("agents.form.ccToolsHint")}
                        error={errors.tools?.message}
                    >
                        <TextInput
                            {...register("tools", {
                                validate: (value) => {
                                    const names = parseAgentTools(value);
                                    const blocked = names?.find((name) =>
                                        BLOCKED_CC_TOOLS.has(name),
                                    );
                                    if (blocked !== undefined)
                                        return t("agents.form.ccToolBlocked", { tool: blocked });
                                    return (
                                        !names?.some(
                                            (name) => !AGENT_TOOL_NAME_PATTERN.test(name),
                                        ) || t("agents.form.ccToolsInvalid")
                                    );
                                },
                            })}
                            placeholder="Read, Grep, Glob, Edit, Bash"
                        />
                    </FormField>
                    <Controller
                        control={control}
                        name="permissionMode"
                        render={({ field }) => (
                            <FormField
                                label={t("agents.form.ccPermissionMode")}
                                hint={t(`agents.form.ccMode.${permissionMode}Hint`)}
                            >
                                <Select
                                    value={field.value}
                                    onValueChange={field.onChange}
                                    options={PERMISSION_MODES.map((m) => ({
                                        value: m,
                                        label: t(`agents.form.ccMode.${m}`),
                                    }))}
                                    label={t("agents.form.ccPermissionMode")}
                                />
                            </FormField>
                        )}
                    />
                    {permissionMode === "bypassPermissions" && (
                        <div className="agent-form-notice agent-form-notice--warn" role="note">
                            {t("agents.form.ccBypassImNotice")}
                        </div>
                    )}
                </>
            )}
            {isCodex && (
                <section className="agent-form-section" aria-labelledby="codex-engine-title">
                    <div className="agent-form-section-head">
                        <h3 className="agent-form-section-title" id="codex-engine-title">
                            {t("agents.form.codexEngineTitle")}
                        </h3>
                        <p className="agent-form-section-hint">
                            {t("agents.form.codexEngineHint")}
                        </p>
                    </div>
                    <div className="agent-form-grid">
                        <Controller
                            control={control}
                            name="codexCwd"
                            render={({ field }) => (
                                <FormField
                                    className="agent-form-grid-full"
                                    label={t("agents.form.codexCwd")}
                                    hint={t("agents.form.codexCwdHint")}
                                >
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        options={codexCwdOptions.map((dir, i) => ({
                                            value: dir,
                                            label: dir,
                                            ...(dir === props.cwdChoices[0] &&
                                            i === codexCwdOptions.indexOf(dir)
                                                ? { badge: t("agents.form.codexCwdWorkspace") }
                                                : {}),
                                        }))}
                                        disabled={codexCwdOptions.length === 0}
                                        label={t("agents.form.codexCwd")}
                                    />
                                </FormField>
                            )}
                        />
                        <FormField
                            label={t("agents.form.codexModel")}
                            hint={t("agents.form.codexModelHint")}
                        >
                            <TextInput
                                {...register("codexModel", {
                                    validate: (value) => value.trim().length <= 256,
                                })}
                                maxLength={256}
                                placeholder={t("agents.form.codexModelPlaceholder")}
                            />
                        </FormField>
                        <Controller
                            control={control}
                            name="codexSandbox"
                            render={({ field }) => (
                                <FormField
                                    label={t("agents.form.codexSandbox")}
                                    hint={t("agents.form.codexSandboxHint")}
                                >
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        options={CODEX_SANDBOXES.map((value) => ({
                                            value,
                                            label: t(`agents.form.codexSandboxMode.${value}`),
                                        }))}
                                        label={t("agents.form.codexSandbox")}
                                    />
                                </FormField>
                            )}
                        />
                        <Controller
                            control={control}
                            name="codexApprovalPolicy"
                            render={({ field }) => (
                                <FormField
                                    className="agent-form-grid-full"
                                    label={t("agents.form.codexApproval")}
                                    hint={t("agents.form.codexApprovalHint")}
                                >
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        options={CODEX_APPROVALS.map((value) => ({
                                            value,
                                            label: t(`agents.form.codexApprovalMode.${value}`),
                                        }))}
                                        label={t("agents.form.codexApproval")}
                                    />
                                </FormField>
                            )}
                        />
                    </div>
                    {codexApprovalPolicy !== "never" && (
                        <div className="agent-form-notice agent-form-notice--warn" role="note">
                            {t("agents.form.codexApprovalNotice")}
                        </div>
                    )}
                    <ul
                        className="agent-form-rules agent-form-rules--plain"
                        aria-label={t("agents.form.codexRulesLabel")}
                    >
                        <li>{t("agents.form.codexRuleEngine")}</li>
                        <li>{t("agents.form.codexRuleContext")}</li>
                        <li>{t("agents.form.codexRuleDelivery")}</li>
                        <li>{t("agents.form.codexRuleAuth")}</li>
                    </ul>
                </section>
            )}
            {isCodex && <input type="hidden" {...maxTurnsField} />}
            {!isCodex && (
                <FormField label={t("agents.form.maxTurns")} error={errors.maxTurns?.message}>
                    <TextInput {...maxTurnsField} inputMode="numeric" />
                </FormField>
            )}
            <FormField
                label={t("agents.form.timeoutMinutes")}
                hint={t("agents.form.timeoutMinutesHint")}
                error={errors.timeoutMinutes?.message}
            >
                <TextInput
                    {...register("timeoutMinutes", {
                        validate: (value) =>
                            value.trim() === "" ||
                            isExactAgentInteger(value, 600) ||
                            t("agents.form.timeoutMinutesInvalid"),
                    })}
                    inputMode="numeric"
                    placeholder={t("agents.form.timeoutMinutesAuto")}
                />
            </FormField>
            <FormField
                label={t("agents.form.systemPrompt")}
                hint={t("agents.form.systemPromptHint")}
                action={
                    <span className="agent-form-no-role">
                        <Controller
                            control={control}
                            name="noRolePrompt"
                            rules={{ deps: "systemPrompt" }}
                            render={({ field }) => (
                                <Switch
                                    checked={field.value}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    label={t("agents.form.noRolePrompt")}
                                />
                            )}
                        />
                        {t("agents.form.noRolePrompt")}
                    </span>
                }
            >
                <Textarea
                    {...register("systemPrompt", {
                        validate: (value, draft) =>
                            (draft.noRolePrompt || value.trim() !== "") &&
                            value.trim().length <= 65536,
                    })}
                    rows={12}
                    maxLength={65536}
                    disabled={noRolePrompt}
                />
            </FormField>
        </Modal>
    );
}
