/**
 * AgentForm — create or edit a user agent definition under $TACO_HOME/agents.
 *
 * Runtime is optional and defaults to "standard" (taco's own harness); the
 * model never sees it — it delegates by agent name only. There is no tools
 * picker yet, so a standard agent inherits the parent's toolset, same as a
 * hand-written md file without a `tools:` line.
 */
import type { AgentRuntime } from "@taco-ai/protocol";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const RUNTIME_OPTIONS: ReadonlyArray<{ value: AgentRuntime; labelKey: string }> = [
    { value: "standard", labelKey: "agents.runtimeStandard" },
    { value: "claude-code", labelKey: "agents.runtimeCc" },
];

/** What the form produces; the pane adds `previousAgentType`. */
export interface AgentFormValue {
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    systemPrompt: string;
}

export interface AgentFormProps {
    /** Edit mode: prefill from the existing definition. Undefined = create. */
    existing?: AgentFormValue;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
    /** Save errors (RPC-level) are shown in the form so the draft survives. */
    error?: string | null;
    onSave: (value: AgentFormValue) => void;
    onCancel: () => void;
}

export function AgentForm(props: AgentFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;

    const [agentType, setAgentType] = useState(props.existing?.agentType ?? "");
    const [description, setDescription] = useState(props.existing?.description ?? "");
    const [whenToUse, setWhenToUse] = useState(props.existing?.whenToUse ?? "");
    const [runtime, setRuntime] = useState<AgentRuntime>(props.existing?.runtime ?? "standard");
    const [maxTurns, setMaxTurns] = useState(String(props.existing?.maxTurns ?? 30));
    const [systemPrompt, setSystemPrompt] = useState(props.existing?.systemPrompt ?? "");

    const trimmedType = agentType.trim();
    const typeValid = AGENT_TYPE_PATTERN.test(trimmedType);
    const turns = Number.parseInt(maxTurns.trim(), 10);
    const turnsValid = Number.isInteger(turns) && turns >= 1 && String(turns) === maxTurns.trim();
    const canSave =
        typeValid && description.trim() !== "" && turnsValid && systemPrompt.trim() !== "";

    const save = () => {
        if (!canSave) return;
        props.onSave({
            agentType: trimmedType,
            description: description.trim(),
            whenToUse: whenToUse.trim() === "" ? undefined : whenToUse.trim(),
            runtime,
            maxTurns: turns,
            systemPrompt,
        });
    };

    return (
        <Modal
            open
            onClose={props.onCancel}
            title={isEdit ? t("agents.form.editTitle") : t("agents.form.newTitle")}
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
                <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
            <FormField label={t("agents.form.whenToUse")}>
                <TextInput value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} />
            </FormField>
            <FormField
                label={t("agents.form.runtime")}
                hint={
                    runtime === "claude-code"
                        ? t("agents.form.runtimeCcHint")
                        : t("agents.form.runtimeStandardHint")
                }
            >
                <Select
                    value={runtime}
                    onValueChange={(v) => setRuntime(v as AgentRuntime)}
                    options={RUNTIME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                    label={t("agents.form.runtime")}
                />
            </FormField>
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
                />
            </FormField>
        </Modal>
    );
}
