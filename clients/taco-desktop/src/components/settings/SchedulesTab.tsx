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
 * Each row's History button opens `ScheduleHistoryDialog` with the job's
 * recent runs and, for agent jobs, what each run answered.
 *
 * Row actions are icon buttons with a hover label (ui/Tooltip): four text
 * buttons wrapped onto two lines in the action column and knocked the rows
 * out of alignment. The delete button is rendered on every row — a built-in
 * job gets a disabled one, so the action column has the same shape
 * everywhere and the reason it cannot be deleted stays reachable.
 *
 * Not yet covered: per-job timezone pickers, and a structured command
 * editor. The `args` field is edited as raw JSON; tightening that is a
 * follow-up.
 */

import type { Job } from "@taco-ai/protocol";
import { History, LoaderCircle, Pencil, Play, Plus, Trash, TriangleAlert } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useNow } from "../../hooks/useNow.ts";
import { useT, useUiLanguage } from "../../i18n/useI18n.ts";
import { createJobsClient } from "../../lib/clients/jobsClient.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { formatRelativeTime } from "../../lib/relativeTime.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton, type IconButtonTone } from "../ui/IconButton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Tag } from "../ui/Tag.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { ScheduleFormDialog, type ScheduleSubmit } from "./ScheduleFormDialog.tsx";
import { ScheduleHistoryDialog } from "./ScheduleHistoryDialog.tsx";

export interface SchedulesTabProps {
    client: TacoClient;
    /** Open the session a run happened in, from the history dialog. */
    onOpenSession: (workspace: string, sessionId: string) => void;
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

export function SchedulesTab({ client, onOpenSession }: SchedulesTabProps) {
    const jobs = useJobsClient(client);
    const { t } = useT();
    /** Shared clock + language for the "last run" column — read once here
     *  so every row renders the same timestamp instead of each row
     *  subscribing to the clock on its own. */
    const nowMs = useNow();
    const lng = useUiLanguage();
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
    /** Job awaiting the shared confirm dialog — deletion discards its run history. */
    const [pendingDelete, setPendingDelete] = useState<Job | null>(null);
    /** Job whose run history dialog is open. */
    const [historyJob, setHistoryJob] = useState<Job | null>(null);

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
                    ? jobs.update({
                          id: mode.job.id,
                          ...submit,
                          // `builtin` is not a form field; preserve it so the
                          // server keeps this on the built-in update path.
                          ...(mode.job.builtin ? { builtin: true } : {}),
                      })
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
                <h3>{t("settings.tabSchedules")}</h3>
                <Button variant="primary" size="sm" onClick={openCreate}>
                    <Plus size={14} aria-hidden="true" />
                    {t("schedules.addButton")}
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
                        aria-label={t("schedules.actionDismiss")}
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
                    <col className="schedules-col-lastrun" />
                    <col className="schedules-col-enabled" />
                    <col className="schedules-col-actions" />
                </colgroup>
                <thead>
                    <tr>
                        <th>{t("schedules.columnName")}</th>
                        <th>{t("schedules.columnSchedule")}</th>
                        <th>{t("schedules.columnCommand")}</th>
                        <th>{t("schedules.columnLastRun")}</th>
                        <th>{t("schedules.columnEnabled")}</th>
                        <th className="schedules-cell-actions">{t("schedules.columnActions")}</th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.length === 0 ? (
                        <tr>
                            <td colSpan={6} className="ui-empty schedules-empty">
                                {t("schedules.empty")}
                            </td>
                        </tr>
                    ) : null}
                    {sorted.map((job) => (
                        <ScheduleRow
                            key={job.id}
                            job={job}
                            nowMs={nowMs}
                            lng={lng}
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
                                    const result = await jobs.runNow(job.id);
                                    if (result.status === "skipped") {
                                        jobs.setActionError(
                                            t(
                                                "schedules.busy",
                                                "Previous run still in progress, please wait",
                                            ),
                                        );
                                    } else if (result.status === "failed") {
                                        jobs.setActionError(
                                            result.error ?? t("schedules.runFailed"),
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
                            onDelete={() => setPendingDelete(job)}
                            onEdit={() => openEdit(job)}
                            onHistory={() => setHistoryJob(job)}
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

            <ConfirmModal
                open={pendingDelete !== null}
                title={t("schedules.deleteConfirmTitle")}
                message={pendingDelete?.name ?? ""}
                confirmLabel={t("schedules.actionDeleteConfirm")}
                cancelLabel={t("schedules.actionCancel")}
                onConfirm={() => {
                    const job = pendingDelete;
                    setPendingDelete(null);
                    if (job === null) return;
                    void jobs
                        .delete(job.id)
                        .then(() => jobs.refresh())
                        .catch((err: unknown) =>
                            jobs.setActionError(err instanceof Error ? err.message : String(err)),
                        );
                }}
                onCancel={() => setPendingDelete(null)}
            />

            <ScheduleHistoryDialog
                client={client}
                job={historyJob}
                onClose={() => setHistoryJob(null)}
                onOpenSession={(workspace, sessionId) => {
                    setHistoryJob(null);
                    onOpenSession(workspace, sessionId);
                }}
            />
        </div>
    );
}

interface RowActionProps {
    /** The hover label — also the button's accessible name. */
    label: string;
    icon: ReactElement;
    disabled?: boolean;
    tone?: IconButtonTone;
    onClick: () => void;
}

/** One row action: an icon button with a hover label.
 *
 *  The label lives in the app's Tooltip so every hover hint in the desktop
 *  draws the same bubble. The trigger is a wrapper span rather than the
 *  button itself: a disabled button swallows its own pointer events, so
 *  the tooltip would never open on it — and the one action that needs to
 *  explain itself ("built-in schedules can't be deleted") is exactly the
 *  disabled one. The span stands in for the pointer events the button
 *  gives up; the keyboard focus stays on the button, and the tooltip
 *  opens on that focus too. */
function RowAction({ label, icon, disabled = false, tone = "default", onClick }: RowActionProps) {
    return (
        <Tooltip label={label} side="left">
            <span className="schedules-action-slot">
                <IconButton aria-label={label} tone={tone} disabled={disabled} onClick={onClick}>
                    {icon}
                </IconButton>
            </span>
        </Tooltip>
    );
}

/** Why the scheduler switched this job off on its own. */
type AutoDisabled =
    | { kind: "maxRuns"; count: number; max: number }
    | { kind: "failures"; count: number }
    | { kind: "raw"; reason: string };

/** The daemon writes a free-form English sentence into `disabled_reason`;
 *  the job's own counters say the same thing in a form this UI can
 *  localize, so prefer them and keep the raw text as the fallback. */
function autoDisabled(job: Job): AutoDisabled | null {
    if (!job.disabled_reason) return null;
    const runCount = job.run_count ?? 0;
    const maxRuns = job.max_runs;
    if (maxRuns !== undefined && runCount >= maxRuns) {
        return { kind: "maxRuns", count: runCount, max: maxRuns };
    }
    const failures = job.consecutive_failures ?? 0;
    if (failures > 0) return { kind: "failures", count: failures };
    return { kind: "raw", reason: job.disabled_reason };
}

interface ScheduleRowProps {
    job: Job;
    /** True while a Run Now click for this row is awaiting the daemon's
     *  fire-accepted response. Disables the button + swaps its icon for a
     *  spinner so the click registers visibly. */
    isRunning: boolean;
    /** Shared clock, for the relative "last run" timestamp. */
    nowMs: number;
    /** Active UI language, for that timestamp. */
    lng: string;
    onToggle: (enabled: boolean) => void;
    onRunNow: () => void;
    onDelete: () => void;
    onEdit: () => void;
    onHistory: () => void;
}

function ScheduleRow({
    job,
    isRunning,
    nowMs,
    lng,
    onToggle,
    onRunNow,
    onDelete,
    onEdit,
    onHistory,
}: ScheduleRowProps) {
    const { t } = useT();
    const scheduleLabel =
        job.schedule.kind === "cron"
            ? `cron: ${job.schedule.expr}${job.schedule.tz ? ` (${job.schedule.tz})` : ""}`
            : `every ${job.schedule.ms}ms`;
    const lastRun = job.last_run_at ? formatRelativeTime(job.last_run_at, lng, nowMs) : "";
    const auto = autoDisabled(job);
    const disabledReason =
        auto === null
            ? null
            : auto.kind === "maxRuns"
              ? t("schedules.autoDisabledMaxRuns", { count: auto.count, max: auto.max })
              : auto.kind === "failures"
                ? t("schedules.autoDisabledFailures", { count: auto.count })
                : auto.reason;
    // A built-in job cannot be deleted, so its delete button is disabled —
    // but the hint has to say why, otherwise the greyed-out control reads
    // as a broken button.
    const deleteLabel = job.builtin ? t("schedules.deleteDisabled") : t("schedules.actionDelete");
    const runLabel = isRunning ? t("schedules.runningNow") : t("schedules.actionRunNow");
    return (
        <tr>
            <td className="schedules-cell-name">
                <div className="schedules-name">
                    <span className="schedules-name-text" title={job.name}>
                        {job.name}
                    </span>
                    {job.builtin ? (
                        <Tag size="sm" className="schedules-builtin-badge">
                            {t("schedules.builtin")}
                        </Tag>
                    ) : null}
                </div>
            </td>
            <td className="schedules-cell-schedule">
                <code title={scheduleLabel}>{scheduleLabel}</code>
            </td>
            <td className="schedules-cell-command">
                <code title={job.command}>{job.command}</code>
                {job.history?.[0]?.summary ? (
                    <div className="schedules-last-summary" title={job.history[0].summary}>
                        {job.history[0].summary}
                    </div>
                ) : null}
            </td>
            <td className="schedules-cell-lastrun">{lastRun || t("schedules.neverRun")}</td>
            <td className="schedules-cell-enabled">
                <div className="schedules-enabled-control">
                    <Switch
                        checked={job.enabled}
                        onChange={onToggle}
                        label={t("schedules.toggleAria")}
                    />
                    {disabledReason ? (
                        // The reason is a hover detail, not a column: written
                        // out it wrapped the cell and stretched the row past
                        // its neighbours.
                        <Tooltip label={disabledReason} side="top">
                            <span
                                className="schedules-auto-disabled"
                                role="img"
                                aria-label={disabledReason}
                            >
                                <TriangleAlert size={13} aria-hidden="true" />
                            </span>
                        </Tooltip>
                    ) : null}
                </div>
            </td>
            <td className="schedules-cell-actions">
                <div className="schedules-row-actions">
                    <RowAction
                        label={runLabel}
                        disabled={isRunning}
                        onClick={onRunNow}
                        icon={
                            isRunning ? (
                                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                            ) : (
                                <Play size={14} aria-hidden="true" />
                            )
                        }
                    />
                    <RowAction
                        label={t("schedules.actionHistory")}
                        onClick={onHistory}
                        icon={<History size={14} aria-hidden="true" />}
                    />
                    <RowAction
                        label={t("schedules.actionEdit")}
                        onClick={onEdit}
                        icon={<Pencil size={14} aria-hidden="true" />}
                    />
                    <RowAction
                        label={deleteLabel}
                        tone="danger"
                        disabled={job.builtin === true}
                        onClick={onDelete}
                        icon={<Trash size={14} aria-hidden="true" />}
                    />
                </div>
            </td>
        </tr>
    );
}
