import { useEffect, useId, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import type { MemoryDreamConfig } from "../../hooks/useMemoryPane";
import { useT } from "../../i18n/useI18n";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { TextInput } from "../ui/TextInput";
import type { MemoryDreamActions } from "./MemoryDreamPanel";

// These are the memory-dream job's accepted integer ranges.
const NUMBER_FIELDS = [
    { name: "minHours", min: 1, max: 720 },
    { name: "staleDays", min: 7, max: 3650 },
    { name: "staleDaysDurable", min: 7, max: 3650 },
] as const;

export function DreamSettings({
    config,
    onSave,
    open,
    onSaved,
}: {
    config: MemoryDreamConfig;
    onSave: MemoryDreamActions["onSaveConfig"];
    open: boolean;
    onSaved: () => void;
}) {
    const { t } = useT();
    const cleanupId = useId();
    const submitting = useRef(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const {
        register,
        control,
        reset,
        trigger,
        handleSubmit,
        formState: { errors, isValid, isSubmitting },
    } = useForm<MemoryDreamConfig>({ defaultValues: config, mode: "onChange" });
    const cleanupEnabled = useWatch({ control, name: "archiveCleanupEnabled" });
    const appliedConfig = useRef(config);
    useEffect(() => {
        // reset clears RHF submission state; apply refreshed values after the save settles.
        if (isSubmitting || appliedConfig.current === config) return;
        appliedConfig.current = config;
        reset(config);
        void trigger();
    }, [config, reset, trigger, isSubmitting]);
    useEffect(() => {
        // A stored value can already be out of range: surface the error without a keystroke.
        void trigger();
    }, [trigger]);

    const save = async () => {
        if (submitting.current) return;
        submitting.current = true;
        try {
            await handleSubmit(async (draft) => {
                setSaveFailed(false);
                try {
                    if (await onSave(draft)) onSaved();
                    else setSaveFailed(true);
                } catch {
                    setSaveFailed(true);
                }
            })();
        } finally {
            submitting.current = false;
        }
    };
    return (
        <div className="memory-dream-settings" hidden={!open} aria-busy={isSubmitting}>
            {NUMBER_FIELDS.map(({ name, min, max }) => (
                <FormField
                    key={name}
                    label={t(`memory.dream.${name}`)}
                    className="memory-dream-settings-field"
                    error={errors[name]?.message}
                >
                    <TextInput
                        type="number"
                        step={1}
                        min={min}
                        max={max}
                        disabled={isSubmitting}
                        {...register(name, {
                            valueAsNumber: true,
                            validate: (value) =>
                                (Number.isInteger(value) && value >= min && value <= max) ||
                                t("memory.dream.invalidNumber", { min, max }),
                        })}
                    />
                </FormField>
            ))}
            <Controller
                control={control}
                name="archiveCleanupEnabled"
                render={({ field }) => (
                    <div className="memory-dream-settings-check">
                        <Switch
                            id={cleanupId}
                            labelledBy={`${cleanupId}-label`}
                            checked={field.value}
                            disabled={isSubmitting}
                            onChange={field.onChange}
                        />
                        <label id={`${cleanupId}-label`} htmlFor={cleanupId}>
                            {t("memory.dream.archiveCleanup")}
                        </label>
                    </div>
                )}
            />
            <Controller
                control={control}
                name="archiveRetentionDays"
                render={({ field }) => (
                    <FormField
                        label={t("memory.dream.archiveRetention")}
                        className="memory-dream-settings-field"
                    >
                        <Select
                            value={String(field.value)}
                            disabled={isSubmitting || !cleanupEnabled}
                            onValueChange={(value) => field.onChange(Number(value))}
                            options={[
                                { value: "7", label: t("memory.dream.archiveRetention7") },
                                { value: "30", label: t("memory.dream.archiveRetention30") },
                                { value: "90", label: t("memory.dream.archiveRetention90") },
                            ]}
                        />
                    </FormField>
                )}
            />
            <div className="memory-dream-settings-actions">
                {saveFailed ? <span role="alert">{t("memory.dream.error.settings")}</span> : null}
                <Button
                    size="sm"
                    variant="primary"
                    disabled={!isValid || isSubmitting}
                    onClick={save}
                >
                    {isSubmitting ? t("app.saving") : t("memory.dream.saveSettings")}
                </Button>
            </div>
        </div>
    );
}
