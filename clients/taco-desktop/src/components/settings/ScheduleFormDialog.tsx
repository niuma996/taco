/** Schedule-specific RHF form; each opening and existing-job replacement gets a fresh instance. */
import type { Job, JobScheduleSpec } from "@taco-ai/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";
import {
    isImArgs,
    type ScheduleDraft,
    type ScheduleSubmit,
    scheduleDefaults,
    scheduleResolver,
    scheduleSubmit,
} from "./scheduleFormValues";

export type { ScheduleSubmit } from "./scheduleFormValues";

export interface ScheduleFormDialogProps {
    open: boolean;
    existing?: Job;
    saving?: boolean;
    /** Parent-owned RPC error, retained alongside the draft for retry. */
    errorMessage?: string | null;
    onSave: (draft: ScheduleSubmit) => void | Promise<void>;
    onCancel: () => void;
}

const SCHEDULE_KIND_OPTIONS = [
    { value: "interval", label: "interval" },
    { value: "cron", label: "cron" },
] as const;

const SESSION_STRATEGY_OPTIONS = [
    { value: "pin", label: "pin — fixed dedicated session" },
    { value: "new", label: "new — fresh session per fire" },
    { value: "reuse", label: "reuse — continue an existing session" },
] as const;

const ARGS_PLACEHOLDER = '{\n  "workspace": "/path/to/repo",\n  "prompt": "…"\n}';

export function ScheduleFormDialog(props: ScheduleFormDialogProps) {
    const [identity, setIdentity] = useState({ existing: props.existing, version: 0 });
    if (identity.existing !== props.existing) {
        setIdentity({ existing: props.existing, version: identity.version + 1 });
    }
    // Unmount on close and remount on job replacement so old RHF promises
    // cannot release a new form's lock or overwrite its submitting state.
    return props.open ? <ScheduleForm key={identity.version} {...props} /> : null;
}

function ScheduleForm(props: ScheduleFormDialogProps) {
    const { t } = useT();
    const { open, existing, errorMessage, onSave, onCancel } = props;
    const isEdit = existing !== undefined;
    const isBuiltinDream = existing?.builtin === true && existing.command === "memory.dream";
    const enabledId = useId();
    const runOnStartupId = useId();
    const {
        register,
        control,
        handleSubmit,
        setValue,
        trigger,
        formState: { errors, isValid, isSubmitting },
    } = useForm<ScheduleDraft>({
        defaultValues: scheduleDefaults(existing),
        resolver: scheduleResolver,
        mode: "onChange",
    });
    const scheduleKind = useWatch({ control, name: "scheduleKind" });
    const argsJson = useWatch({ control, name: "argsJson" });
    const isImWorkspace = isImArgs(argsJson);
    const saving = props.saving || isSubmitting;
    const submitting = useRef(false);
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        // Errors are live even for the initial empty JSON draft.
        void trigger();
        return () => {
            active.current = false;
        };
    }, [trigger]);

    const save = async () => {
        if (props.saving || submitting.current || !active.current) return;
        submitting.current = true;
        try {
            await handleSubmit(async (values) => {
                // Validation yields; the dialog may have closed or changed jobs.
                if (active.current) await onSave(scheduleSubmit(values));
            })();
        } catch {
            // The parent displays RPC errors and preserves this draft for retry.
        } finally {
            submitting.current = false;
        }
    };

    const updateScheduleKind = (kind: JobScheduleSpec["kind"]) => {
        if (kind === scheduleKind) return;
        setValue("intervalMs", "60000");
        setValue("cronExpr", "*/5 * * * *");
        setValue("cronTz", "");
        setValue("scheduleKind", kind, { shouldDirty: true });
        void trigger();
    };

    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={
                isEdit
                    ? t("schedules.editTitle", "Edit schedule")
                    : t("schedules.newTitle", "New schedule")
            }
            description={
                isEdit
                    ? t(
                          "schedules.editDescription",
                          "Update this schedule — changes apply on save.",
                      )
                    : t(
                          "schedules.newDescription",
                          "Fill in the fields below to register a job with the scheduler.",
                      )
            }
            className="schedules-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={onCancel} disabled={saving}>
                        {t("schedules.actionCancel", "Cancel")}
                    </Button>
                    <Button variant="primary" disabled={!isValid || saving} onClick={save}>
                        {isEdit
                            ? t("schedules.actionSave", "Save")
                            : t("schedules.actionCreate", "Create")}
                    </Button>
                </>
            }
        >
            <FormField label={t("schedules.fieldName", "Name")}>
                <TextInput
                    id="schedules-form-name"
                    type="text"
                    {...register("name")}
                    disabled={isBuiltinDream}
                />
            </FormField>

            <Controller
                control={control}
                name="scheduleKind"
                render={({ field }) => (
                    <FormField label={t("schedules.fieldScheduleKind", "Kind")}>
                        <Select
                            value={field.value}
                            onValueChange={(v) => updateScheduleKind(v as JobScheduleSpec["kind"])}
                            options={SCHEDULE_KIND_OPTIONS}
                            label={t("schedules.fieldScheduleKind", "Kind")}
                        />
                    </FormField>
                )}
            />

            {scheduleKind === "interval" ? (
                <FormField
                    label={t("schedules.fieldIntervalMs", "Interval (ms)")}
                    hint={t(
                        "schedules.fieldIntervalMsHint",
                        "Trigger interval in milliseconds. Must be a positive integer.",
                    )}
                    error={
                        errors.intervalMs
                            ? t(
                                  "schedules.errorIntervalMs",
                                  "Interval (ms) must be a positive integer.",
                              )
                            : undefined
                    }
                >
                    <TextInput
                        id="schedules-form-interval-ms"
                        type="number"
                        min={1}
                        {...register("intervalMs")}
                    />
                </FormField>
            ) : (
                <>
                    <FormField
                        label={t("schedules.fieldCronExpr", "Cron expression")}
                        hint={t(
                            "schedules.fieldCronExprHint",
                            "Standard 5-field cron expression, e.g. 30 22 * * *.",
                        )}
                        error={
                            errors.cronExpr
                                ? t("schedules.errorCronExpr", "Cron expression must not be empty.")
                                : undefined
                        }
                    >
                        <TextInput
                            id="schedules-form-cron-expr"
                            type="text"
                            {...register("cronExpr")}
                        />
                    </FormField>
                    <FormField
                        label={t("schedules.fieldCronTz", "Timezone (optional)")}
                        hint={t(
                            "schedules.fieldCronTzHint",
                            "Leave empty to use the host local timezone, e.g. Asia/Shanghai.",
                        )}
                    >
                        <TextInput
                            id="schedules-form-cron-tz"
                            type="text"
                            {...register("cronTz")}
                        />
                    </FormField>
                </>
            )}

            <FormField label={t("schedules.fieldCommand", "Command")}>
                <TextInput
                    id="schedules-form-command"
                    type="text"
                    {...register("command")}
                    disabled={isBuiltinDream}
                />
            </FormField>

            <FormField
                label={t("schedules.fieldArgs", "Args (JSON object)")}
                error={errors.argsJson?.message ? t(errors.argsJson.message) : undefined}
            >
                <Textarea
                    id="schedules-form-args"
                    rows={4}
                    {...register("argsJson")}
                    placeholder={ARGS_PLACEHOLDER}
                    disabled={isBuiltinDream}
                />
            </FormField>

            {!isBuiltinDream ? (
                <Controller
                    control={control}
                    name="sessionStrategy"
                    render={({ field }) => (
                        <FormField
                            label={t("schedules.fieldSessionStrategy", "Session strategy")}
                            hint={
                                isImWorkspace
                                    ? t(
                                          "schedules.sessionStrategyImHint",
                                          "im:// workspaces can only reuse the current session; the server rejects other strategies.",
                                      )
                                    : undefined
                            }
                        >
                            <Select
                                value={isImWorkspace ? "reuse" : field.value}
                                onValueChange={field.onChange}
                                options={SESSION_STRATEGY_OPTIONS}
                                disabled={isImWorkspace}
                                label={t("schedules.fieldSessionStrategy", "Session strategy")}
                            />
                        </FormField>
                    )}
                />
            ) : null}

            {!isBuiltinDream ? (
                <FormField
                    label={t("schedules.fieldMaxRuns", "Max runs")}
                    hint={t(
                        "schedules.fieldMaxRunsHint",
                        "The job disables itself after this many successful runs (its record is kept). Leave empty for unlimited; set 1 for a one-shot task.",
                    )}
                    error={
                        errors.maxRunsInput
                            ? t(
                                  "schedules.errorMaxRuns",
                                  "Max runs must be a positive integer, or empty for unlimited.",
                              )
                            : undefined
                    }
                >
                    <TextInput
                        id="schedules-form-max-runs"
                        type="number"
                        min={1}
                        {...register("maxRunsInput")}
                    />
                </FormField>
            ) : null}

            <div className="schedules-modal-toggles">
                <label className="schedules-modal-toggle" htmlFor={enabledId}>
                    <Controller
                        control={control}
                        name="enabled"
                        render={({ field }) => (
                            <Switch
                                id={enabledId}
                                checked={field.value}
                                onChange={field.onChange}
                                onBlur={field.onBlur}
                                label={t("schedules.fieldEnabled", "Enabled")}
                            />
                        )}
                    />
                    <span>{t("schedules.fieldEnabled", "Enabled")}</span>
                </label>
                {!isBuiltinDream ? (
                    <label className="schedules-modal-toggle" htmlFor={runOnStartupId}>
                        <Controller
                            control={control}
                            name="run_on_startup"
                            render={({ field }) => (
                                <Switch
                                    id={runOnStartupId}
                                    checked={field.value}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    label={t("schedules.fieldRunOnStartup", "Run on startup")}
                                />
                            )}
                        />
                        <span>{t("schedules.fieldRunOnStartup", "Run on startup")}</span>
                    </label>
                ) : null}
            </div>

            {isBuiltinDream ? (
                <p className="schedules-builtin-note">{t("schedules.builtinNote")}</p>
            ) : null}

            {errorMessage ? (
                <p className="schedules-error" role="alert">
                    {errorMessage}
                </p>
            ) : null}
        </Modal>
    );
}
