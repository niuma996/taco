import type { Job, JobScheduleSpec, SessionStrategy } from "@taco-ai/protocol";
import type { FieldErrors, Resolver } from "react-hook-form";

export interface ScheduleDraft {
    name: string;
    scheduleKind: JobScheduleSpec["kind"];
    intervalMs: string;
    cronExpr: string;
    cronTz: string;
    command: string;
    argsJson: string;
    enabled: boolean;
    run_on_startup: boolean;
    sessionStrategy: SessionStrategy;
    maxRunsInput: string;
}

export interface ScheduleSubmit {
    name: string;
    schedule: JobScheduleSpec;
    command: string;
    args: Record<string, unknown>;
    enabled: boolean;
    run_on_startup: boolean;
    sessionStrategy: SessionStrategy;
    /** Omitted entirely when the field is empty (unlimited). */
    max_runs?: number;
}

export function scheduleDefaults(job?: Job): ScheduleDraft {
    return {
        name: job?.name ?? "",
        scheduleKind: job?.schedule.kind ?? "interval",
        intervalMs: job?.schedule.kind === "interval" ? String(job.schedule.ms) : "60000",
        cronExpr: job?.schedule.kind === "cron" ? job.schedule.expr : "*/5 * * * *",
        cronTz: job?.schedule.kind === "cron" ? (job.schedule.tz ?? "") : "",
        command: job?.command ?? "agent.invoke",
        argsJson: job ? JSON.stringify(job.args, null, 2) : "",
        enabled: job?.enabled ?? true,
        run_on_startup: job?.run_on_startup ?? false,
        sessionStrategy: job?.sessionStrategy ?? "pin",
        maxRunsInput: job?.max_runs != null ? String(job.max_runs) : "",
    };
}

export function isImArgs(argsJson: string): boolean {
    try {
        const args = JSON.parse(argsJson) as { workspace?: unknown } | null;
        return typeof args?.workspace === "string" && args.workspace.startsWith("im://");
    } catch {
        return false;
    }
}

export const scheduleResolver: Resolver<ScheduleDraft> = (values) => {
    const errors: FieldErrors<ScheduleDraft> = {};
    if (!values.name.trim()) errors.name = { type: "required" };
    // Keep the scheduler form's existing parseInt conversion, including truncation.
    if (values.scheduleKind === "interval" && (Number.parseInt(values.intervalMs, 10) || 0) <= 0) {
        errors.intervalMs = { type: "validate", message: "schedules.errorIntervalMs" };
    }
    if (values.scheduleKind === "cron" && !values.cronExpr.trim()) {
        errors.cronExpr = { type: "required", message: "schedules.errorCronExpr" };
    }
    const maxRuns = values.maxRunsInput.trim();
    if (
        maxRuns !== "" &&
        !(/^\d+$/.test(maxRuns) && !/^0\d+$/.test(maxRuns) && Number.parseInt(maxRuns, 10) >= 1)
    ) {
        errors.maxRunsInput = { type: "validate", message: "schedules.errorMaxRuns" };
    }
    try {
        const args: unknown = JSON.parse(values.argsJson);
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
            errors.argsJson = { type: "validate", message: "schedules.errorArgsNotObject" };
        }
    } catch {
        errors.argsJson = { type: "validate", message: "schedules.errorArgsJson" };
    }
    return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} };
};

/** Called only after resolver validation; server-managed job fields never enter this payload. */
export function scheduleSubmit(values: ScheduleDraft): ScheduleSubmit {
    const maxRuns = values.maxRunsInput.trim();
    return {
        name: values.name.trim(),
        schedule:
            values.scheduleKind === "interval"
                ? { kind: "interval", ms: Number.parseInt(values.intervalMs, 10) || 0 }
                : {
                      kind: "cron",
                      expr: values.cronExpr,
                      ...(values.cronTz ? { tz: values.cronTz } : {}),
                  },
        command: values.command.trim() || "agent.invoke",
        args: JSON.parse(values.argsJson) as Record<string, unknown>,
        enabled: values.enabled,
        run_on_startup: values.run_on_startup,
        sessionStrategy: isImArgs(values.argsJson) ? "reuse" : values.sessionStrategy,
        ...(maxRuns === "" ? {} : { max_runs: Number.parseInt(maxRuns, 10) }),
    };
}
