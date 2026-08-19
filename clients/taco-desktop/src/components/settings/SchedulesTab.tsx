/**
 * SchedulesTab — surfaces the daemon's scheduler as a CRUD UI. Each
 * row is one `Job` (id + name + schedule + enable/disable + last-run
 * timestamp); the panel lets the user add new jobs, edit existing
 * ones, run them immediately, and delete them.
 *
 * Persistence: jobs live as JSON files under $TACO_HOME/jobs/. The
 * UI is stateless — `useEffect` re-fetches on mount + after every
 * mutation; the daemon is the source of truth.
 *
 * Scope kept narrow for PR4: the panel does not yet visualize history
 * (the plan defers that), support per-job timezone pickers, or fold
 * the command editor into a structured form. The `args` field is
 * edited as raw JSON; tightening that is a follow-up.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { createJobsClient, type Job, type JobScheduleSpec } from "../../lib/jobsClient.ts";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";

export interface SchedulesTabProps {
    client: TacoClient;
}

interface DraftJob {
    name: string;
    schedule: JobScheduleSpec;
    command: string;
    argsJson: string;
    enabled: boolean;
    run_on_startup: boolean;
}

const EMPTY_DRAFT: DraftJob = {
    name: "",
    schedule: { kind: "interval", ms: 60_000 },
    command: "agent.invoke",
    argsJson: "{}",
    enabled: true,
    run_on_startup: false,
};

export function SchedulesTab({ client }: SchedulesTabProps) {
    const jobs = useJobsClient(client);
    const { t } = useT();
    const [draft, setDraft] = useState<DraftJob>(EMPTY_DRAFT);
    const [formError, setFormError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    /** Job id whose Run Now click is currently in flight. The button text
     *  flips to "running…" while this is set so the click registers visibly
     *  — without this the only feedback is a history entry that lands
     *  minutes later (the agent session itself runs for a while), and the
     *  user assumes the click was a no-op. Cleared in the same finally
     *  block whether the fire was accepted or skipped. */
    const [runningId, setRunningId] = useState<string | null>(null);

    const submit = useCallback(() => {
        setFormError(null);
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(draft.argsJson) as Record<string, unknown>;
            if (typeof args !== "object" || args === null || Array.isArray(args)) {
                throw new Error("args must be a JSON object");
            }
        } catch (err) {
            setFormError(`args: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (!draft.name.trim()) {
            setFormError("name must not be empty");
            return;
        }
        if (draft.schedule.kind === "interval" && draft.schedule.ms <= 0) {
            setFormError("interval.ms must be a positive integer");
            return;
        }
        if (draft.schedule.kind === "cron" && !draft.schedule.expr.trim()) {
            setFormError("cron expr must not be empty");
            return;
        }
        const id = editingId ?? newJobId();
        const next: Job = {
            id,
            name: draft.name.trim(),
            schedule: draft.schedule,
            command: draft.command.trim() || "agent.invoke",
            args,
            enabled: draft.enabled,
            run_on_startup: draft.run_on_startup,
            history: editingId ? (jobs.list.find((j) => j.id === id)?.history ?? []) : [],
        };
        const target = editingId ? jobs.update(next) : jobs.create(next);
        void target
            .then(() => {
                setDraft(EMPTY_DRAFT);
                setEditingId(null);
                void jobs.refresh();
            })
            .catch((err: unknown) => {
                setFormError(err instanceof Error ? err.message : String(err));
            });
    }, [draft, editingId, jobs]);

    const beginEdit = useCallback((job: Job) => {
        setEditingId(job.id);
        setDraft({
            name: job.name,
            schedule: job.schedule,
            command: job.command,
            argsJson: JSON.stringify(job.args, null, 2),
            enabled: job.enabled,
            run_on_startup: job.run_on_startup,
        });
        setFormError(null);
    }, []);

    const cancelEdit = useCallback(() => {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
        setFormError(null);
    }, []);

    const sorted = useMemo(
        () => [...jobs.list].sort((a, b) => a.name.localeCompare(b.name)),
        [jobs.list],
    );

    return (
        <div className="settings-tab schedules-tab">
            <h3>{t("settings.tabSchedules", "Schedules")}</h3>
            {jobs.error ? (
                <p className="schedules-error" role="alert">
                    {jobs.error}
                </p>
            ) : null}
            <table className="schedules-table">
                <thead>
                    <tr>
                        <th>{t("schedules.columnName", "Name")}</th>
                        <th>{t("schedules.columnSchedule", "Schedule")}</th>
                        <th>{t("schedules.columnCommand", "Command")}</th>
                        <th>{t("schedules.columnEnabled", "Enabled")}</th>
                        <th>{t("schedules.columnActions", "Actions")}</th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="schedules-empty">
                                {t("schedules.empty", "No schedules yet.")}
                            </td>
                        </tr>
                    ) : null}
                    {sorted.map((job) => (
                        <ScheduleRow
                            key={job.id}
                            job={job}
                            isRunning={runningId === job.id}
                            onToggle={(enabled) => {
                                void jobs
                                    .update({ ...job, enabled })
                                    .then(() => jobs.refresh())
                                    .catch((err: unknown) =>
                                        jobs.setError(
                                            err instanceof Error ? err.message : String(err),
                                        ),
                                    );
                            }}
                            onRunNow={async () => {
                                // Reflect the click instantly in the UI —
                                // runNow returns immediately even when the
                                // underlying fire will take minutes, so
                                // without flipping the button text the
                                // click looks like nothing happened. Set
                                // runningId first so the disabled / label
                                // change commits before the awaited RPC,
                                // and clear it in the same finally so we
                                // never get stuck showing "运行中…" if the
                                // call rejects.
                                setRunningId(job.id);
                                try {
                                    const accepted = await jobs.runNow(job.id);
                                    if (!accepted) {
                                        jobs.setError(
                                            t("schedules.busy", "上次运行还没结束,请稍候再触发"),
                                        );
                                    } else {
                                        jobs.setError(null);
                                    }
                                } catch (err) {
                                    jobs.setError(err instanceof Error ? err.message : String(err));
                                } finally {
                                    await jobs.refresh();
                                    setRunningId((prev) => (prev === job.id ? null : prev));
                                }
                            }}
                            onDelete={() => {
                                void jobs
                                    .delete(job.id)
                                    .then(() => jobs.refresh())
                                    .catch((err: unknown) =>
                                        jobs.setError(
                                            err instanceof Error ? err.message : String(err),
                                        ),
                                    );
                            }}
                            onEdit={() => beginEdit(job)}
                        />
                    ))}
                </tbody>
            </table>

            <h4>
                {editingId
                    ? t("schedules.editTitle", "Edit schedule")
                    : t("schedules.newTitle", "New schedule")}
            </h4>
            <form
                className="schedules-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                <label>
                    <span>{t("schedules.fieldName", "Name")}</span>
                    <input
                        type="text"
                        value={draft.name}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                </label>
                <fieldset className="schedules-schedule">
                    <legend>{t("schedules.fieldSchedule", "Schedule")}</legend>
                    <label>
                        <span>{t("schedules.fieldScheduleKind", "Kind")}</span>
                        <select
                            value={draft.schedule.kind}
                            onChange={(event) => {
                                const kind = event.target.value;
                                if (kind === "cron") {
                                    setDraft({
                                        ...draft,
                                        schedule: { kind: "cron", expr: "*/5 * * * *" },
                                    });
                                } else {
                                    setDraft({
                                        ...draft,
                                        schedule: { kind: "interval", ms: 60_000 },
                                    });
                                }
                            }}
                        >
                            <option value="interval">interval</option>
                            <option value="cron">cron</option>
                        </select>
                    </label>
                    {draft.schedule.kind === "interval" ? (
                        <label>
                            <span>{t("schedules.fieldIntervalMs", "Interval (ms)")}</span>
                            <input
                                type="number"
                                min={1}
                                value={draft.schedule.ms}
                                onChange={(event) =>
                                    setDraft({
                                        ...draft,
                                        schedule: {
                                            kind: "interval",
                                            ms: Number.parseInt(event.target.value, 10) || 0,
                                        },
                                    })
                                }
                            />
                        </label>
                    ) : (
                        <>
                            <label>
                                <span>{t("schedules.fieldCronExpr", "Cron expression")}</span>
                                <input
                                    type="text"
                                    value={
                                        draft.schedule.kind === "cron" ? draft.schedule.expr : ""
                                    }
                                    onChange={(event) =>
                                        setDraft({
                                            ...draft,
                                            schedule: {
                                                kind: "cron",
                                                expr: event.target.value,
                                                tz:
                                                    draft.schedule.kind === "cron"
                                                        ? draft.schedule.tz
                                                        : undefined,
                                            },
                                        })
                                    }
                                />
                            </label>
                            <label>
                                <span>{t("schedules.fieldCronTz", "Timezone (optional)")}</span>
                                <input
                                    type="text"
                                    value={
                                        draft.schedule.kind === "cron"
                                            ? (draft.schedule.tz ?? "")
                                            : ""
                                    }
                                    onChange={(event) =>
                                        setDraft({
                                            ...draft,
                                            schedule: {
                                                kind: "cron",
                                                expr:
                                                    draft.schedule.kind === "cron"
                                                        ? draft.schedule.expr
                                                        : "",
                                                tz: event.target.value || undefined,
                                            },
                                        })
                                    }
                                />
                            </label>
                        </>
                    )}
                </fieldset>
                <label>
                    <span>{t("schedules.fieldCommand", "Command")}</span>
                    <input
                        type="text"
                        value={draft.command}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                    />
                </label>
                <label>
                    <span>{t("schedules.fieldArgs", "Args (JSON object)")}</span>
                    <textarea
                        rows={4}
                        value={draft.argsJson}
                        onChange={(event) => setDraft({ ...draft, argsJson: event.target.value })}
                    />
                </label>
                <label className="schedules-toggle">
                    <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    <span>{t("schedules.fieldEnabled", "Enabled")}</span>
                </label>
                <label className="schedules-toggle">
                    <input
                        type="checkbox"
                        checked={draft.run_on_startup}
                        onChange={(event) =>
                            setDraft({ ...draft, run_on_startup: event.target.checked })
                        }
                    />
                    <span>{t("schedules.fieldRunOnStartup", "Run on startup")}</span>
                </label>
                {formError ? <p className="schedules-error">{formError}</p> : null}
                <div className="schedules-form-actions">
                    <button type="submit" disabled={jobs.busy}>
                        {editingId
                            ? t("schedules.actionSave", "Save")
                            : t("schedules.actionCreate", "Create")}
                    </button>
                    {editingId ? (
                        <button type="button" onClick={cancelEdit}>
                            {t("schedules.actionCancel", "Cancel")}
                        </button>
                    ) : null}
                </div>
            </form>
        </div>
    );
}

interface ScheduleRowProps {
    job: Job;
    /** True while a Run Now click for this row is awaiting the daemon's
     *  fire-accepted response. Disables the button + changes its label so
     *  the click registers visibly. */
    isRunning: boolean;
    onToggle: (enabled: boolean) => void;
    onRunNow: () => void;
    onDelete: () => void;
    onEdit: () => void;
}

function ScheduleRow({ job, isRunning, onToggle, onRunNow, onDelete, onEdit }: ScheduleRowProps) {
    const { t } = useT();
    const scheduleLabel =
        job.schedule.kind === "cron"
            ? `cron: ${job.schedule.expr}${job.schedule.tz ? ` (${job.schedule.tz})` : ""}`
            : `every ${job.schedule.ms}ms`;
    return (
        <tr>
            <td>{job.name}</td>
            <td>
                <code>{scheduleLabel}</code>
            </td>
            <td>
                <code>{job.command}</code>
            </td>
            <td>
                <input
                    type="checkbox"
                    checked={job.enabled}
                    onChange={(event) => onToggle(event.target.checked)}
                    aria-label={t("schedules.toggleAria", "Toggle schedule enabled")}
                />
            </td>
            <td className="schedules-row-actions">
                <button type="button" onClick={onRunNow} disabled={isRunning}>
                    {isRunning
                        ? t("schedules.runningNow", "运行中…")
                        : t("schedules.actionRunNow", "Run now")}
                </button>
                <button type="button" onClick={onEdit}>
                    {t("schedules.actionEdit", "Edit")}
                </button>
                <button type="button" onClick={onDelete}>
                    {t("schedules.actionDelete", "Delete")}
                </button>
            </td>
        </tr>
    );
}

/** Tiny custom hook: wraps the jobs client with refresh-on-mount + a
 *  busy / error state the UI can render. Stays local to this file —
 *  other tabs would duplicate the pattern, but the alternative (a
 *  generic `useRpcList`) isn't load-bearing yet. */
function useJobsClient(client: TacoClient) {
    const jobsClient = useMemo(() => createJobsClient(client), [client]);
    const [list, setList] = useState<Job[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setBusy(true);
        try {
            setList(await jobsClient.list());
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [jobsClient]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return {
        list,
        busy,
        error,
        setError,
        refresh,
        create: jobsClient.create,
        update: jobsClient.update,
        delete: jobsClient.delete,
        runNow: jobsClient.runNow,
    };
}

function newJobId(): string {
    // Crypto-random UUID without a runtime dep — the scheduler's lock
    // path already uses randomUUID, so this matches.
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
