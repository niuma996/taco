import type { Job } from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleFormDialog } from "../../../src/components/settings/ScheduleFormDialog";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(cleanup);

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-a",
        name: "Job A",
        schedule: { kind: "interval", ms: 60_000 },
        command: "agent.invoke",
        args: {},
        enabled: true,
        run_on_startup: false,
        sessionStrategy: "pin",
        ...overrides,
    };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function input(key: string) {
    return screen.getByLabelText(`schedules.field${key}`);
}

function change(key: string, value: string) {
    fireEvent.change(input(key), { target: { value } });
}

async function choose(key: string, option: string) {
    const user = userEvent.setup({ delay: null });
    await user.click(input(key));
    await user.click(screen.getByRole("option", { name: option }));
}

function saveButton(edit = true) {
    return screen.getByRole("button", {
        name: edit ? "schedules.actionSave" : "schedules.actionCreate",
    });
}

async function ready(edit = true) {
    await waitFor(() => expect(saveButton(edit)).toHaveProperty("disabled", false));
}

describe("ScheduleFormDialog contract", () => {
    it("starts with live JSON errors and requires a trimmed name and object args", async () => {
        const onSave = vi.fn();
        render(<ScheduleFormDialog open onSave={onSave} onCancel={vi.fn()} />);
        expect(await screen.findByText("schedules.errorArgsJson")).toBeTruthy();
        expect(saveButton(false)).toHaveProperty("disabled", true);
        change("Name", "   ");
        change("Args", "{}");
        expect(saveButton(false)).toHaveProperty("disabled", true);
        change("Name", "  Nightly  ");
        await ready(false);
        fireEvent.click(saveButton(false));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0]?.[0]).toEqual({
            name: "Nightly",
            schedule: { kind: "interval", ms: 60_000 },
            command: "agent.invoke",
            args: {},
            enabled: true,
            run_on_startup: false,
            sessionStrategy: "pin",
        });
    });

    it.each(["{", "[]", "null", "1", '"text"', "true"])(
        "rejects args %s live and recovers when corrected",
        async (value) => {
            const onSave = vi.fn();
            render(<ScheduleFormDialog open existing={job()} onSave={onSave} onCancel={vi.fn()} />);
            await ready();
            change("Args", value);
            const error = await screen.findByText(
                value === "{" ? "schedules.errorArgsJson" : "schedules.errorArgsNotObject",
            );
            expect(saveButton()).toHaveProperty("disabled", true);
            expect(input("Args").getAttribute("aria-invalid")).toBe("true");
            expect(input("Args").getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
            fireEvent.click(saveButton());
            expect(onSave).not.toHaveBeenCalled();
            change("Args", '{"prompt":"hello"}');
            await ready();
            expect(screen.queryByText("schedules.errorArgsNotObject")).toBeNull();
        },
    );

    it.each(["0", "-1", "1.5", "01", "1e2"])("rejects max runs %s", async (value) => {
        const onSave = vi.fn();
        render(<ScheduleFormDialog open existing={job()} onSave={onSave} onCancel={vi.fn()} />);
        await ready();
        change("MaxRuns", value);
        expect(await screen.findByText("schedules.errorMaxRuns")).toBeTruthy();
        expect(saveButton()).toHaveProperty("disabled", true);
        fireEvent.click(saveButton());
        expect(onSave).not.toHaveBeenCalled();
        change("MaxRuns", "2");
        await ready();
        fireEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ max_runs: 2 })),
        );
    });

    it("omits a cleared max_runs key and preserves interval parseInt conversion", async () => {
        const onSave = vi.fn();
        render(
            <ScheduleFormDialog
                open
                existing={job({ max_runs: 4 })}
                onSave={onSave}
                onCancel={vi.fn()}
            />,
        );
        await ready();
        change("MaxRuns", "");
        change("IntervalMs", "1.9");
        change("Command", "   ");
        await ready();
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const submitted = onSave.mock.calls[0]?.[0];
        expect(submitted.schedule).toEqual({ kind: "interval", ms: 1 });
        expect(submitted.command).toBe("agent.invoke");
        expect("max_runs" in submitted).toBe(false);
    });

    it("validates interval positivity and cron nonemptiness, and resets branch defaults", async () => {
        const onSave = vi.fn();
        render(<ScheduleFormDialog open existing={job()} onSave={onSave} onCancel={vi.fn()} />);
        await ready();
        change("IntervalMs", "0");
        expect(await screen.findByText("schedules.errorIntervalMs")).toBeTruthy();
        expect(saveButton()).toHaveProperty("disabled", true);
        await choose("ScheduleKind", "cron");
        expect(input("CronExpr")).toHaveProperty("value", "*/5 * * * *");
        change("CronExpr", "   ");
        expect(await screen.findByText("schedules.errorCronExpr")).toBeTruthy();
        expect(saveButton()).toHaveProperty("disabled", true);
        change("CronExpr", "daemon validates this");
        change("CronTz", "Asia/Shanghai");
        await ready();
        fireEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                expect.objectContaining({
                    schedule: { kind: "cron", expr: "daemon validates this", tz: "Asia/Shanghai" },
                }),
            ),
        );
        await choose("ScheduleKind", "interval");
        expect(input("IntervalMs")).toHaveProperty("value", "60000");
        await choose("ScheduleKind", "cron");
        expect(input("CronExpr")).toHaveProperty("value", "*/5 * * * *");
        expect(input("CronTz")).toHaveProperty("value", "");
        const kind = input("ScheduleKind");
        expect(document.querySelector(`label[for="${kind.id}"]`)?.textContent).toBe(
            "schedules.fieldScheduleKind",
        );
    });

    it("forces IM reuse in the payload and restores the prior user strategy when leaving", async () => {
        const onSave = vi.fn();
        render(<ScheduleFormDialog open existing={job()} onSave={onSave} onCancel={vi.fn()} />);
        await ready();
        await choose("SessionStrategy", "new — fresh session per fire");
        change("Args", '{"workspace":"im://channel"}');
        await waitFor(() => expect(input("SessionStrategy")).toHaveProperty("disabled", true));
        expect(input("SessionStrategy").textContent).toContain("reuse");
        fireEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                expect.objectContaining({ sessionStrategy: "reuse" }),
            ),
        );
        change("Args", '{"workspace":"/tmp/repo"}');
        await waitFor(() => expect(input("SessionStrategy")).toHaveProperty("disabled", false));
        expect(input("SessionStrategy").textContent).toContain("new — fresh session per fire");
        fireEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenLastCalledWith(
                expect.objectContaining({ sessionStrategy: "new" }),
            ),
        );
    });

    it("includes disabled built-in fields and hidden settings in the save", async () => {
        const onSave = vi.fn();
        render(
            <ScheduleFormDialog
                open
                existing={job({
                    builtin: true,
                    command: "memory.dream",
                    args: { minHours: 24 },
                    run_on_startup: true,
                    max_runs: 3,
                })}
                onSave={onSave}
                onCancel={vi.fn()}
            />,
        );
        await ready();
        for (const key of ["Name", "Command", "Args"])
            expect(input(key)).toHaveProperty("disabled", true);
        expect(screen.queryByLabelText("schedules.fieldSessionStrategy")).toBeNull();
        expect(screen.queryByLabelText("schedules.fieldMaxRuns")).toBeNull();
        fireEvent.click(screen.getByRole("switch", { name: "schedules.fieldEnabled" }));
        fireEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: "Job A",
                    command: "memory.dream",
                    args: { minHours: 24 },
                    enabled: false,
                    run_on_startup: true,
                    max_runs: 3,
                }),
            ),
        );
    });

    it("resets on existing replacement and on reopen", async () => {
        const onSave = vi.fn();
        const props = { onSave, onCancel: vi.fn() };
        const first = job();
        const { rerender } = render(<ScheduleFormDialog open existing={first} {...props} />);
        await ready();
        change("Name", "Draft");
        rerender(<ScheduleFormDialog open existing={job({ name: "Replacement" })} {...props} />);
        expect(input("Name")).toHaveProperty("value", "Replacement");
        rerender(<ScheduleFormDialog open={false} {...props} />);
        rerender(<ScheduleFormDialog open {...props} />);
        expect(input("Name")).toHaveProperty("value", "");
        expect(input("Args")).toHaveProperty("value", "");
        expect(saveButton(false)).toHaveProperty("disabled", true);
    });
});

describe("ScheduleFormDialog async submit", () => {
    it("blocks synchronous duplicates and stays busy until onSave resolves", async () => {
        const pending = deferred();
        const onSave = vi.fn(() => pending.promise);
        render(<ScheduleFormDialog open existing={job()} onSave={onSave} onCancel={vi.fn()} />);
        await ready();
        act(() => {
            saveButton().click();
            saveButton().click();
        });
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(saveButton()).toHaveProperty("disabled", true);
        expect(screen.getByRole("button", { name: "schedules.actionCancel" })).toHaveProperty(
            "disabled",
            true,
        );
        await act(async () => pending.resolve());
        await ready();
    });

    it("releases the lock on rejection and retains the draft and parent error for retry", async () => {
        const pending = deferred();
        const onSave = vi
            .fn()
            .mockImplementationOnce(() => pending.promise)
            .mockResolvedValue(undefined);
        const existing = job();
        const props = { open: true, existing, onSave, onCancel: vi.fn() };
        const { rerender } = render(<ScheduleFormDialog {...props} />);
        await ready();
        change("Name", "Retry draft");
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        await act(async () => pending.reject(new Error("daemon rejected")));
        rerender(<ScheduleFormDialog {...props} errorMessage="daemon rejected" />);
        await ready();
        expect(screen.getByRole("alert").textContent).toBe("daemon rejected");
        expect(input("Name")).toHaveProperty("value", "Retry draft");
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
        expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Retry draft" }));
    });

    it("does not save an old form when the job changes before async validation finishes", async () => {
        const onSave = vi.fn();
        const props = { open: true, onSave, onCancel: vi.fn() };
        const { rerender } = render(<ScheduleFormDialog {...props} existing={job()} />);
        await ready();
        act(() => {
            saveButton().click();
            rerender(
                <ScheduleFormDialog {...props} existing={job({ id: "job-b", name: "Job B" })} />,
            );
        });
        await ready();
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Job B" }));
    });

    it("isolates the lock of a reopened form from an older pending save", async () => {
        const oldSave = deferred();
        const newSave = deferred();
        const onSave = vi
            .fn()
            .mockImplementationOnce(() => oldSave.promise)
            .mockImplementationOnce(() => newSave.promise);
        const existing = job();
        const props = { existing, onSave, onCancel: vi.fn() };
        const { rerender } = render(<ScheduleFormDialog open {...props} />);
        await ready();
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        rerender(<ScheduleFormDialog open={false} {...props} />);
        rerender(<ScheduleFormDialog open {...props} />);
        await ready();
        change("Name", "New opening");
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
        await act(async () => oldSave.resolve());
        expect(saveButton()).toHaveProperty("disabled", true);
        await act(async () => newSave.resolve());
        await ready();
        expect(input("Name")).toHaveProperty("value", "New opening");
    });
});
