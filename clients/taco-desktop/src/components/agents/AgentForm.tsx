/**
 * AgentForm — create or edit a user agent definition under $TACO_HOME/agents.
 *
 * v1 covers `runtime: claude-code` agents only: pi agents need a tools
 * whitelist UI, which is deliberately out of scope. The form carries no
 * runtime picker — every save writes `runtime: claude-code`.
 */
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** What the form produces; the pane adds `runtime` and `previousAgentType`. */
export interface AgentFormValue {
    agentType: string;
    description: string;
    whenToUse?: string;
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
            maxTurns: turns,
            systemPrompt,
        });
    };

    return (
        <Modal
            open
            onClose={props.onCancel}
            title={isEdit ? t("agents.form.editTitle") : t("agents.form.newTitle")}
            description={t("agents.form.runtimeHint")}
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
                    placeholder="my-cc-reader"
                />
            </FormField>
            <FormField label={t("agents.form.description")}>
                <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
            <FormField label={t("agents.form.whenToUse")}>
                <TextInput value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} />
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
