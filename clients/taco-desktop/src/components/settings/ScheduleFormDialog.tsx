/**
 * ScheduleFormDialog — add/edit a single scheduled job in a Radix Dialog.
 *
 * Owns its own draft state so opening the modal always starts from a
 * clean slate (or the existing job's values when `existing` is given).
 * Validation lives in `validateDraft` — `canSubmit` and `handleSubmit`
 * both call into it so a missing / wrong-shape check shows up the same
 * way in the disabled-button state and the inline error.
 *
 * Wider than the base `.modal` (see `.schedules-modal` in settings.css)
 * so the cron expression, JSON args, and the action row sit on a
 * comfortable single column. The inline form that lived at the bottom
 * of SchedulesTab was getting squeezed by the 720px content cap and the
 * tables stacking underneath it; a dialog keeps the list scannable.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import type { Job, JobScheduleSpec, SessionStrategy } from "../../lib/jobsClient.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface ScheduleDraft {
    name: string;
    schedule: JobScheduleSpec;
    command: string;
    argsJson: string;
    enabled: boolean;
    run_on_startup: boolean;
    sessionStrategy: SessionStrategy;
}

export interface ScheduleSubmit {
    name: string;
    schedule: JobScheduleSpec;
    command: string;
    args: Record<string, unknown>;
    enabled: boolean;
    run_on_startup: boolean;
    sessionStrategy: SessionStrategy;
}

export interface ScheduleFormDialogProps {
    open: boolean;
    /** When provided, the dialog edits this job; otherwise it creates a new one. */
    existing?: Job;
    /** Disables both action buttons while the parent's RPC is in flight. */
    saving?: boolean;
    /** Parent-owned error message (e.g. daemon rejection). Rendered inside
     *  the dialog so the user sees it next to the form, not as a banner
     *  that disappears on the next list refresh. */
    errorMessage?: string | null;
    onSave: (draft: ScheduleSubmit) => void;
    onCancel: () => void;
}

const EMPTY_DRAFT: ScheduleDraft = {
    name: "",
    schedule: { kind: "interval", ms: 60_000 },
    command: "agent.invoke",
    // Empty by default so the placeholder ("{}") is what the user sees;
    // a prefilled "{}" looked like example content and confused users
    // about whether they needed to overwrite it (see #7 in the review).
    argsJson: "",
    enabled: true,
    run_on_startup: false,
    sessionStrategy: "pin",
};

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

function draftFromJob(job: Job): ScheduleDraft {
    return {
        name: job.name,
        schedule: job.schedule,
        command: job.command,
        argsJson: JSON.stringify(job.args, null, 2),
        enabled: job.enabled,
        run_on_startup: job.run_on_startup,
        sessionStrategy: job.sessionStrategy ?? "pin",
    };
}

/** Single source of truth for "is this draft ready to submit?". Both
 *  `canSubmit` (button disabled state) and `handleSubmit` (gate on
 *  submit click) call into here so the user can't bypass the gate by
 *  clicking faster than React renders, and the inline errors shown
 *  under each field stay consistent with the gating rules. */
type DraftError =
    | { field: "name"; message: string }
    | { field: "intervalMs"; message: string }
    | { field: "cronExpr"; message: string }
    | { field: "argsJson"; message: string };

function validateDraft(draft: ScheduleDraft): {
    ok: boolean;
    args?: Record<string, unknown>;
    errors: DraftError[];
} {
    const errors: DraftError[] = [];
    // Empty name is a blocking error but not surfaced inline — the
    // Name input's placeholder + disabled submit button is enough
    // signal. Adding a red error message under the field duplicates
    // the placeholder hint without adding information.
    const nameOk = draft.name.trim().length > 0;
    if (draft.schedule.kind === "interval" && draft.schedule.ms <= 0) {
        errors.push({ field: "intervalMs", message: "Interval must be a positive integer." });
    }
    if (draft.schedule.kind === "cron" && !draft.schedule.expr.trim()) {
        errors.push({ field: "cronExpr", message: "Cron expression must not be empty." });
    }
    let args: Record<string, unknown> | undefined;
    try {
        const parsed = JSON.parse(draft.argsJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            errors.push({
                field: "argsJson",
                message: "Args must be a JSON object, not an array or primitive.",
            });
        } else {
            args = parsed as Record<string, unknown>;
        }
    } catch {
        errors.push({ field: "argsJson", message: "JSON parse failed — check braces and quotes." });
    }
    return { ok: nameOk && errors.length === 0, args, errors };
}

export function ScheduleFormDialog(props: ScheduleFormDialogProps) {
    const { t } = useT();
    const { open, existing, saving, errorMessage, onSave, onCancel } = props;
    const isEdit = existing !== undefined;

    const [draft, setDraft] = useState<ScheduleDraft>(EMPTY_DRAFT);

    // Sync the draft whenever the dialog opens so closing & reopening
    // for a different job doesn't carry the previous job's values.
    useEffect(() => {
        if (!open) return;
        setDraft(existing ? draftFromJob(existing) : EMPTY_DRAFT);
    }, [open, existing]);

    // Channel jobs (im:// workspace) only support sessionStrategy="reuse"
    // server-side — JobsController rejects anything else. Detect the
    // workspace from the args draft so the form can lock the strategy
    // picker instead of letting the user save a guaranteed failure.
    // Disabled Radix Select already prevents changes; we keep the full
    // option list visible so the user can read the available values.
    const isImWorkspace = useMemo(() => {
        try {
            const parsed = JSON.parse(draft.argsJson) as { workspace?: unknown };
            return typeof parsed?.workspace === "string" && parsed.workspace.startsWith("im://");
        } catch {
            return false;
        }
    }, [draft.argsJson]);

    const effectiveStrategy: SessionStrategy = isImWorkspace ? "reuse" : draft.sessionStrategy;

    const updateScheduleKind = useCallback((kind: JobScheduleSpec["kind"]) => {
        setDraft((prev) => {
            if (prev.schedule.kind === kind) return prev;
            if (kind === "cron") {
                return { ...prev, schedule: { kind: "cron", expr: "*/5 * * * *" } };
            }
            return { ...prev, schedule: { kind: "interval", ms: 60_000 } };
        });
    }, []);

    const updateCronExpr = useCallback((expr: string) => {
        setDraft((prev) => {
            if (prev.schedule.kind !== "cron") return prev;
            return { ...prev, schedule: { ...prev.schedule, expr } };
        });
    }, []);

    const updateCronTz = useCallback((tz: string) => {
        setDraft((prev) => {
            if (prev.schedule.kind !== "cron") return prev;
            return { ...prev, schedule: { ...prev.schedule, tz: tz || undefined } };
        });
    }, []);

    const updateIntervalMs = useCallback((raw: string) => {
        const ms = Number.parseInt(raw, 10) || 0;
        setDraft((prev) => {
            if (prev.schedule.kind !== "interval") return prev;
            return { ...prev, schedule: { ...prev.schedule, ms } };
        });
    }, []);

    const setStrategy = useCallback((next: SessionStrategy) => {
        setDraft((prev) => ({ ...prev, sessionStrategy: next }));
    }, []);

    const validation = useMemo(() => validateDraft(draft), [draft]);
    const canSubmit = validation.ok;

    const handleSubmit = useCallback(() => {
        if (!validation.ok || validation.args === undefined) {
            // The button is disabled when validation fails, so this
            // branch only fires if the user reaches it programmatically
            // (e.g. Enter in a field). Re-validate and bail — the
            // inline errors are already on screen.
            return;
        }
        onSave({
            name: draft.name.trim(),
            schedule: draft.schedule,
            command: draft.command.trim() || "agent.invoke",
            args: validation.args,
            enabled: draft.enabled,
            run_on_startup: draft.run_on_startup,
            sessionStrategy: effectiveStrategy,
        });
    }, [draft, effectiveStrategy, onSave, validation]);

    const errorFor = useCallback(
        (field: DraftError["field"]): string | undefined => {
            const match = validation.errors.find((e) => e.field === field);
            if (!match) return undefined;
            // Localise the message keys so the dialog errors follow
            // the same translation pipeline as the rest of the form.
            if (field === "argsJson") {
                if (match.message.startsWith("JSON parse")) {
                    return t("schedules.errorArgsJson", "JSON 解析失败，请检查括号和引号。");
                }
                return t(
                    "schedules.errorArgsNotObject",
                    "args 必须是 JSON 对象，不能是数组或基本类型。",
                );
            }
            return match.message;
        },
        [t, validation.errors],
    );

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content className="modal schedules-modal">
                    <Dialog.Title className="modal-title">
                        {isEdit
                            ? t("schedules.editTitle", "Edit schedule")
                            : t("schedules.newTitle", "New schedule")}
                    </Dialog.Title>
                    <Dialog.Description className="modal-message">
                        {isEdit
                            ? t(
                                  "schedules.editDescription",
                                  "修改这条定时任务的参数；保存后立即生效。",
                              )
                            : t(
                                  "schedules.newDescription",
                                  "填好下面这几项就可以把任务挂到调度器上。",
                              )}
                    </Dialog.Description>

                    <FormField label={t("schedules.fieldName", "Name")}>
                        <TextInput
                            id="schedules-form-name"
                            type="text"
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                    </FormField>

                    <FormField label={t("schedules.fieldScheduleKind", "Kind")}>
                        <Select
                            value={draft.schedule.kind}
                            onValueChange={(v) => updateScheduleKind(v as JobScheduleSpec["kind"])}
                            options={SCHEDULE_KIND_OPTIONS}
                            label={t("schedules.fieldScheduleKind", "Kind")}
                        />
                    </FormField>

                    {draft.schedule.kind === "interval" ? (
                        <FormField
                            label={t("schedules.fieldIntervalMs", "Interval (ms)")}
                            hint={t(
                                "schedules.fieldIntervalMsHint",
                                "触发间隔（毫秒）。需为正整数。",
                            )}
                            error={
                                errorFor("intervalMs")
                                    ? t("schedules.errorIntervalMs", "Interval (ms) 必须是正整数。")
                                    : undefined
                            }
                        >
                            <TextInput
                                id="schedules-form-interval-ms"
                                type="number"
                                min={1}
                                value={String(draft.schedule.ms)}
                                onChange={(e) => updateIntervalMs(e.target.value)}
                            />
                        </FormField>
                    ) : (
                        <>
                            <FormField
                                label={t("schedules.fieldCronExpr", "Cron expression")}
                                hint={t(
                                    "schedules.fieldCronExprHint",
                                    "标准 5 段 cron 表达式，例如 30 22 * * *。",
                                )}
                                error={
                                    errorFor("cronExpr")
                                        ? t("schedules.errorCronExpr", "Cron 表达式不能为空。")
                                        : undefined
                                }
                            >
                                <TextInput
                                    id="schedules-form-cron-expr"
                                    type="text"
                                    value={
                                        draft.schedule.kind === "cron" ? draft.schedule.expr : ""
                                    }
                                    onChange={(e) => updateCronExpr(e.target.value)}
                                />
                            </FormField>
                            <FormField
                                label={t("schedules.fieldCronTz", "Timezone (optional)")}
                                hint={t(
                                    "schedules.fieldCronTzHint",
                                    "留空则使用宿主本地时区，例如 Asia/Shanghai。",
                                )}
                            >
                                <TextInput
                                    id="schedules-form-cron-tz"
                                    type="text"
                                    value={
                                        draft.schedule.kind === "cron"
                                            ? (draft.schedule.tz ?? "")
                                            : ""
                                    }
                                    onChange={(e) => updateCronTz(e.target.value)}
                                />
                            </FormField>
                        </>
                    )}

                    <FormField label={t("schedules.fieldCommand", "Command")}>
                        <TextInput
                            id="schedules-form-command"
                            type="text"
                            value={draft.command}
                            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                        />
                    </FormField>

                    <FormField
                        label={t("schedules.fieldArgs", "Args (JSON object)")}
                        hint={t(
                            "schedules.fieldArgsHint",
                            "传递给命令的 JSON 对象，例如 { workspace, prompt }。",
                        )}
                        error={errorFor("argsJson")}
                    >
                        <Textarea
                            id="schedules-form-args"
                            rows={4}
                            value={draft.argsJson}
                            placeholder={ARGS_PLACEHOLDER}
                            onChange={(e) => setDraft({ ...draft, argsJson: e.target.value })}
                        />
                    </FormField>

                    <FormField
                        label={t("schedules.fieldSessionStrategy", "Session strategy")}
                        hint={
                            isImWorkspace
                                ? t(
                                      "schedules.sessionStrategyImHint",
                                      "im:// 工作区只能复用当前会话，服务器会拒绝其他选项。",
                                  )
                                : undefined
                        }
                    >
                        <Select
                            value={effectiveStrategy}
                            onValueChange={(v) => setStrategy(v as SessionStrategy)}
                            options={SESSION_STRATEGY_OPTIONS}
                            disabled={isImWorkspace}
                            label={t("schedules.fieldSessionStrategy", "Session strategy")}
                        />
                    </FormField>

                    <div className="schedules-modal-toggles">
                        <label className="schedules-modal-toggle">
                            <input
                                type="checkbox"
                                checked={draft.enabled}
                                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                            />
                            <span>{t("schedules.fieldEnabled", "Enabled")}</span>
                        </label>
                        <label className="schedules-modal-toggle">
                            <input
                                type="checkbox"
                                checked={draft.run_on_startup}
                                onChange={(e) =>
                                    setDraft({ ...draft, run_on_startup: e.target.checked })
                                }
                            />
                            <span>{t("schedules.fieldRunOnStartup", "Run on startup")}</span>
                        </label>
                    </div>

                    {errorMessage ? (
                        <p className="schedules-error" role="alert">
                            {errorMessage}
                        </p>
                    ) : null}

                    <div className="modal-actions">
                        <Button variant="ghost" onClick={onCancel} disabled={saving}>
                            {t("schedules.actionCancel", "Cancel")}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={!canSubmit || saving}
                            onClick={handleSubmit}
                        >
                            {isEdit
                                ? t("schedules.actionSave", "Save")
                                : t("schedules.actionCreate", "Create")}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
