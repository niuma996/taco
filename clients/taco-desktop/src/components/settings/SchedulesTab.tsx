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
 * Add / edit moved to a Radix Dialog (`ScheduleFormDialog`) so the
 * table view stays scannable. The earlier inline form pushed the
 * table below the fold and squeezed the action buttons; the dialog
 * also gives the form room for hint / error text without breaking
 * the 720px content cap.
 *
 * Scope kept narrow for PR4: the panel does not yet visualize history
 * (the plan defers that), support per-job timezone pickers, or fold
 * the command editor into a structured form. The `args` field is
 * edited as raw JSON; tightening that is a follow-up.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { createJobsClient, type Job } from "../../lib/jobsClient.ts";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import { Button } from "../ui/Button.tsx";
import { ScheduleFormDialog, type ScheduleSubmit } from "./ScheduleFormDialog.tsx";

export interface SchedulesTabProps {
    client: TacoClient;
}

/** Dialog mode — distinguishes between creating a new job (no `existing`
 *  set) and editing one (existing carries the row to pre-fill). The
 *  discriminator lets the dialog pick its own title + submit label
 *  without the parent reaching into the dialog's internals. */
type DialogMode =
    | { kind: "closed" }
    | { kind: "create"; lastError: string | null }
    | { kind: "edit"; job: Job; lastError: string | null };

const EMPTY_DIALOG_MODE: DialogMode = { kind: "closed" };

/** Tiny custom hook: wraps the jobs client with refresh-on-mount + a
 *  busy / error state the UI can render. Stays local to this file —
 *  other tabs would duplicate the pattern, but the alternative (a
 *  generic `useRpcList`) isn't load-bearing yet. */
function useJobsClient(client: TacoClient) {
    const jobsClient = useMemo(() => createJobsClient(client), [client]);
    const [list, setList] = useState<Job[]>([]);
    const [busy, setBusy] = useState(false);
    // Two error buckets: a list-level failure (network/daemon down) is
    // transient and clears on the next successful refresh; an
    // action-level failure (create/update/delete/runNow) is sticky
    // because the user needs to see WHY their edit didn't land and
    // clearing it on a refresh would silently lose context. Earlier
    // we used a single `error` field that refresh could overwrite,
    // which meant a successful refresh after a failed create hid the
    // form error without any user action.
    const [listError, setListError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setBusy(true);
        try {
            const next = await jobsClient.list();
            setList(next);
            // Refresh success ⇒ the daemon is reachable again, so any
            // prior list failure is no longer the user's truth. Leave
            // actionError alone — it's a different state machine.
            setListError(null);
        } catch (err) {
            setListError(err instanceof Error ? err.message : String(err));
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
        listError,
        actionError,
        setActionError,
        refresh,
        create: jobsClient.create,
        update: jobsClient.update,
        delete: jobsClient.delete,
        runNow: jobsClient.runNow,
    };
}

export function SchedulesTab({ client }: SchedulesTabProps) {
    const jobs = useJobsClient(client);
    const { t } = useT();
    /** Dialog mode drives the modal's open state, title, and which
     *  fields it pre-fills. Closed by default so the table is the only
     *  thing on screen. */
    const [dialog, setDialog] = useState<DialogMode>(EMPTY_DIALOG_MODE);
    /** Job id whose Run Now click is currently in flight. The button text
     *  flips to "running…" while this is set so the click registers visibly
     *  — without this the only feedback is a history entry that lands
     *  minutes later (the agent session itself runs for a while), and the
     *  user assumes the click was a no-op. Cleared in the same finally
     *  block whether the fire was accepted or skipped. */
    const [runningId, setRunningId] = useState<string | null>(null);

    const sorted = useMemo(
        () => [...jobs.list].sort((a, b) => a.name.localeCompare(b.name)),
        [jobs.list],
    );

    const openCreate = useCallback(() => {
        // Clear the global actionError so the prior failure doesn't
        // show up under a new dialog via the sticky banner — the
        // dialog's own `lastError` carries per-instance errors instead.
        jobs.setActionError(null);
        setDialog({ kind: "create", lastError: null });
    }, [jobs]);

    const openEdit = useCallback(
        (job: Job) => {
            jobs.setActionError(null);
            setDialog({ kind: "edit", job, lastError: null });
        },
        [jobs],
    );

    const closeDialog = useCallback(() => {
        setDialog(EMPTY_DIALOG_MODE);
    }, []);

    const handleSave = useCallback(
        (mode: DialogMode, submit: ScheduleSubmit) => {
            if (mode.kind === "closed") return;
            // Clear any prior per-dialog error before re-attempting —
            // the rejection handler below re-stamps it on failure.
            setDialog((prev) => (prev.kind === "closed" ? prev : { ...prev, lastError: null }));
            // `history` is a server-managed field (past run records);
            // the desktop must NOT send it on update, otherwise saving
            // an edit wipes the run history. Create accepts it because
            // the server treats `[]` as "no runs yet" — but we still
            // skip sending it to keep create/update symmetric.
            const rpc =
                mode.kind === "edit"
                    ? jobs.update({ id: mode.job.id, ...submit })
                    : jobs.create(submit);
            void rpc
                .then(() => {
                    setDialog(EMPTY_DIALOG_MODE);
                    void jobs.refresh();
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    // Pin the error to THIS dialog instance, not the
                    // global hook — otherwise closing and reopening
                    // shows a stale message from the previous attempt.
                    setDialog((prev) =>
                        prev.kind === "closed" ? prev : { ...prev, lastError: message },
                    );
                });
        },
        [jobs],
    );

    // Per-dialog derived props. `errorMessage` only carries a value when
    // the dialog is open AND has surfaced an error since opening; this
    // prevents stale errors from a previous dialog session from leaking
    // into a freshly opened one.
    const dialogSaving = jobs.busy;
    const dialogExisting = dialog.kind === "edit" ? dialog.job : undefined;
    const dialogErrorMessage = dialog.kind !== "closed" ? dialog.lastError : null;

    return (
        <div className="settings-tab schedules-tab">
            <div className="schedules-tab-header">
                <h3>{t("settings.tabSchedules", "Schedules")}</h3>
                <Button variant="primary" size="sm" onClick={openCreate}>
                    {t("schedules.addButton", "+ New schedule")}
                </Button>
            </div>

            {jobs.listError ? (
                <p className="schedules-error" role="alert">
                    {jobs.listError}
                </p>
            ) : null}
            {jobs.actionError ? (
                <p className="schedules-error schedules-error--action" role="alert">
                    <span>{jobs.actionError}</span>
                    <button
                        type="button"
                        className="schedules-error-dismiss"
                        aria-label={t("schedules.actionDismiss", "Dismiss")}
                        onClick={() => jobs.setActionError(null)}
                    >
                        ×
                    </button>
                </p>
            ) : null}

            <table className="schedules-table">
                <colgroup>
                    <col className="schedules-col-name" />
                    <col className="schedules-col-schedule" />
                    <col className="schedules-col-command" />
                    <col className="schedules-col-enabled" />
                    <col className="schedules-col-actions" />
                </colgroup>
                <thead>
                    <tr>
                        <th>{t("schedules.columnName", "Name")}</th>
                        <th>{t("schedules.columnSchedule", "Schedule")}</th>
                        <th>{t("schedules.columnCommand", "Command")}</th>
                        <th>{t("schedules.columnEnabled", "Enabled")}</th>
                        <th className="schedules-cell-actions">
                            {t("schedules.columnActions", "Actions")}
                        </th>
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
                                        jobs.setActionError(
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
                                        jobs.setActionError(
                                            t("schedules.busy", "上次运行还没结束，请稍候再触发"),
                                        );
                                    } else {
                                        jobs.setActionError(null);
                                    }
                                } catch (err) {
                                    jobs.setActionError(
                                        err instanceof Error ? err.message : String(err),
                                    );
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
                                        jobs.setActionError(
                                            err instanceof Error ? err.message : String(err),
                                        ),
                                    );
                            }}
                            onEdit={() => openEdit(job)}
                        />
                    ))}
                </tbody>
            </table>

            <ScheduleFormDialog
                open={dialog.kind !== "closed"}
                existing={dialogExisting}
                saving={dialogSaving}
                errorMessage={dialogErrorMessage}
                onSave={(submit) => handleSave(dialog, submit)}
                onCancel={closeDialog}
            />
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
            <td className="schedules-cell-name">{job.name}</td>
            <td className="schedules-cell-schedule">
                <code>{scheduleLabel}</code>
            </td>
            <td className="schedules-cell-command">
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
            <td className="schedules-cell-actions">
                <div className="schedules-row-actions">
                    <Button size="sm" variant="default" onClick={onRunNow} disabled={isRunning}>
                        {isRunning
                            ? t("schedules.runningNow", "运行中…")
                            : t("schedules.actionRunNow", "Run now")}
                    </Button>
                    <Button size="sm" variant="default" onClick={onEdit}>
                        {t("schedules.actionEdit", "Edit")}
                    </Button>
                    <Button size="sm" variant="danger" onClick={onDelete}>
                        {t("schedules.actionDelete", "Delete")}
                    </Button>
                </div>
            </td>
        </tr>
    );
}
