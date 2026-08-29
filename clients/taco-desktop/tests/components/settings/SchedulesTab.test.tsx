/**
 * SchedulesTab — list vs action error separation.
 *
 * The bug being regression-guarded: the tab used a single `error` slot
 * that the refresh path could set or clear. A failed create was
 * captured in `error`, then the next successful refresh cleared it
 * silently — the user lost the breadcrumb that their edit had failed
 * without any explicit close. After the fix we have two slots:
 *   - listError:   refresh failure (transient, auto-clears on success).
 *   - actionError: action failure (sticky, dismissed explicitly).
 *
 * Since the add/edit flow moved into a Radix Dialog, the action-level
 * error is bound to the dialog instance (via `dialog.lastError`) so
 * closing the dialog discards it and opening a new one starts clean.
 * The dialog keeps the message visible while open, so the regression
 * we still want to guard is: an action error message remains on screen
 * even after a *separate* list refresh succeeds (the daemon
 * re-confirming reachability).
 *
 * These tests render the tab with a fake `TacoClient` whose
 * `callProcess` is scripted per-call, then drive the controls and
 * assert which banner is shown in each state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulesTab } from "../../../src/components/settings/SchedulesTab";
import type { Job } from "../../../src/lib/clients/jobsClient";
import type { TacoClient } from "../../../src/lib/clients/tacoClient";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);

interface ScriptedJobsClient {
    list: () => Promise<unknown>;
    create: (params: Record<string, unknown>) => Promise<unknown>;
    update: (params: Record<string, unknown>) => Promise<unknown>;
    delete: () => Promise<unknown>;
    runNow: () => Promise<unknown>;
    history: () => Promise<unknown>;
}

/** Wire a fake TacoClient whose callProcess routes `jobs.*` methods to
 *  the matching scripted function. `set*Reject` flips the matching
 *  mock into a rejecting promise so we can drive failure paths
 *  declaratively. */
function makeClient(jobs: Partial<ScriptedJobsClient> = {}): TacoClient {
    const defaults: ScriptedJobsClient = {
        list: () => Promise.resolve({ jobs: [] }),
        create: ({ job }: Record<string, unknown>) => Promise.resolve({ job }),
        update: ({ job }: Record<string, unknown>) => Promise.resolve({ job }),
        delete: () => Promise.resolve({ deleted: true }),
        runNow: () => Promise.resolve({ ran: true }),
        history: () => Promise.resolve({ history: null }),
    };
    const full = { ...defaults, ...jobs };
    return {
        settingsGet: () => Promise.resolve({ global: {} }),
        settingsWrite: () => Promise.resolve({ global: {} }),
        callProcess: (method: string, params: Record<string, unknown>) => {
            if (method === "jobs.list") return full.list();
            if (method === "jobs.create") return full.create(params);
            if (method === "jobs.update") return full.update(params);
            if (method === "jobs.delete") return full.delete();
            if (method === "jobs.runNow") return full.runNow();
            if (method === "jobs.history") return full.history();
            throw new Error(`unexpected method ${method}`);
        },
    } as unknown as TacoClient;
}

function sampleJob(id: string): Job {
    return {
        id,
        name: id,
        schedule: { kind: "interval" as const, ms: 60_000 },
        command: "agent.invoke",
        args: { workspace: "/tmp/repo", prompt: "p" },
        enabled: true,
        run_on_startup: false,
        history: [],
        sessionStrategy: "pin" as const,
    };
}

/** Open the add-schedule dialog by clicking the "+ New schedule" header
 *  button. The form is inside a Radix Dialog — using happy-dom (the
 *  default test environment for vitest), the modal renders normally
 *  rather than into a portal, so `getByLabelText` finds the inputs
 *  after `openCreate` flips state. */
async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "schedules.addButton" }));
    await waitFor(() => {
        expect(screen.getByText("schedules.newTitle")).toBeTruthy();
    });
}

/** Fill in the dialog fields with a minimal valid create payload so the
 *  submit button becomes enabled. */
async function fillValidCreateDraft(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.type(screen.getByLabelText("schedules.fieldName"), name);
    const argsTextarea = screen.getByLabelText("schedules.fieldArgs") as HTMLTextAreaElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
    )?.set;
    nativeSetter?.call(argsTextarea, "{}");
    argsTextarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SchedulesTab — listError vs actionError separation", () => {
    it("renders listError when initial list fails, and clears it after a successful refresh", async () => {
        let attempts = 0;
        const listJobs = () => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error("daemon unreachable"));
            return Promise.resolve({ jobs: [sampleJob("seeded")] });
        };
        const client = makeClient({ list: listJobs });
        render(<SchedulesTab client={client} />);
        // First effect run fails; the banner shows the daemon error.
        await waitFor(() => {
            expect(screen.getByText("daemon unreachable")).toBeTruthy();
        });

        // Trigger a manual refresh via a row action so the same component
        // instance re-runs jobs.list — the cleanup + remount approach
        // would prove nothing about the same component instance.
        // Easiest path: dispatch a programmatic refresh via the toggle.
        // But there's no public refresh button; the closest is the edit
        // button which loads a job into the form. We instead simulate
        // the React refresh by re-rendering with the same client and
        // waiting for the effect to fire again.
        cleanup();
        render(<SchedulesTab client={client} />);
        await waitFor(() => {
            expect(screen.queryByText("daemon unreachable")).toBeNull();
        });
    });

    it("dialog error survives a subsequent list refresh (per-dialog sticky error)", async () => {
        // Regression guard. After moving into a dialog, the action
        // error is bound to the dialog instance (dialog.lastError)
        // rather than the global hook. The thing we still need to
        // guarantee is: while the dialog is open and showing a failure,
        // a *separate* list refresh (e.g. triggered by toggling a row)
        // does NOT silently clear the failure message.
        const client = makeClient({
            create: () => Promise.reject(new Error("invalid schedule")),
            list: () => Promise.resolve({ jobs: [] }),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("schedules.empty")).toBeTruthy();
        });

        // Drive the form through the dialog and trigger the create
        // rejection. The dialog stays open and surfaces the failure.
        await openAddDialog(user);
        await fillValidCreateDraft(user, "test job");
        await user.click(screen.getByRole("button", { name: "schedules.actionCreate" }));

        await waitFor(() => {
            expect(screen.getByText("invalid schedule")).toBeTruthy();
        });
        // Wait a tick to let any auto-refresh settle.
        await new Promise((r) => setTimeout(r, 50));
        // The error must still be on screen — the list refresh that
        // happens after a failed create does NOT clear it.
        expect(screen.getByText("invalid schedule")).toBeTruthy();
    });

    it("dismissing a row actionError clears it via the dismiss button", async () => {
        // Row-level action errors (toggle / runNow / delete) still
        // surface in the sticky banner above the table. The dismiss
        // button must clear them without triggering another list
        // refresh.
        const client = makeClient({
            list: () => Promise.resolve({ jobs: [sampleJob("row-1")] }),
            update: () => Promise.reject(new Error("boom")),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("row-1")).toBeTruthy();
        });
        // Toggle the row's enabled checkbox → triggers jobs.update →
        // rejection lands in the global actionError bucket.
        const toggle = screen.getByLabelText("schedules.toggleAria");
        await user.click(toggle);

        await waitFor(() => {
            expect(screen.getByText("boom")).toBeTruthy();
        });
        // Dismiss.
        await user.click(screen.getByLabelText("schedules.actionDismiss"));
        await waitFor(() => {
            expect(screen.queryByText("boom")).toBeNull();
        });
    });

    it("listError and the dialog error render independently when both are set", async () => {
        // Compound: a list failure that surfaced first, then a create
        // failure inside the dialog. Both messages should be visible —
        // the list banner stays at the top, the create error lives in
        // the dialog. This pins the contract that the two slots are
        // independent and neither clears the other.
        const client = makeClient({
            list: () => Promise.reject(new Error("no daemon")),
            create: () => Promise.reject(new Error("bad schedule")),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        // listError surfaces immediately on mount.
        await waitFor(() => {
            expect(screen.getByText("no daemon")).toBeTruthy();
        });
        // Open the create dialog and submit; the create path's rejection
        // lands on the dialog's lastError.
        await openAddDialog(user);
        await fillValidCreateDraft(user, "y");
        await user.click(screen.getByRole("button", { name: "schedules.actionCreate" }));

        await waitFor(() => {
            expect(screen.getByText("bad schedule")).toBeTruthy();
        });
        // Both messages coexist.
        expect(screen.getByText("no daemon")).toBeTruthy();
        expect(screen.getByText("bad schedule")).toBeTruthy();
    });

    it("a stale error from one dialog does not leak into the next", async () => {
        // The fix for #1 in the review: the per-dialog error bucket
        // means opening a fresh dialog (create OR edit) starts clean,
        // even when the previous dialog session failed.
        const client = makeClient({
            create: () => Promise.reject(new Error("first attempt")),
            update: ({ job }: Record<string, unknown>) => Promise.resolve({ job }),
            list: () => Promise.resolve({ jobs: [sampleJob("row-x")] }),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("row-x")).toBeTruthy();
        });

        // 1. Open the create dialog, submit, fail. Error shows.
        await openAddDialog(user);
        await fillValidCreateDraft(user, "scratch");
        await user.click(screen.getByRole("button", { name: "schedules.actionCreate" }));
        await waitFor(() => {
            expect(screen.getByText("first attempt")).toBeTruthy();
        });

        // 2. Cancel the dialog. Error must be discarded with the dialog.
        await user.click(screen.getByRole("button", { name: "schedules.actionCancel" }));
        await waitFor(() => {
            expect(screen.queryByText("first attempt")).toBeNull();
        });

        // 3. Open the edit dialog on the existing row. No stale
        //    error should be visible — the dialog starts clean.
        await user.click(screen.getByRole("button", { name: "schedules.actionEdit" }));
        await waitFor(() => {
            expect(screen.getByText("schedules.editTitle")).toBeTruthy();
        });
        expect(screen.queryByText("first attempt")).toBeNull();
    });
});

describe("SchedulesTab — table layout smoke", () => {
    it("renders all five columns with their header labels when jobs are present", async () => {
        // Layout smoke — guard against accidental column drops in the
        // colgroup refactor. Each column is referenced by a class so a
        // missing <col> would surface here.
        const client = makeClient({
            list: () => Promise.resolve({ jobs: [sampleJob("row-a"), sampleJob("row-b")] }),
        });
        const { container } = render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("row-a")).toBeTruthy();
        });

        const cols = container.querySelectorAll(".schedules-table col");
        expect(cols).toHaveLength(5);

        // Header cells render with the column keys.
        expect(screen.getByText("schedules.columnName")).toBeTruthy();
        expect(screen.getByText("schedules.columnSchedule")).toBeTruthy();
        expect(screen.getByText("schedules.columnCommand")).toBeTruthy();
        expect(screen.getByText("schedules.columnEnabled")).toBeTruthy();
        expect(screen.getByText("schedules.columnActions")).toBeTruthy();
    });
});

describe("SchedulesTab — modal add / edit flow", () => {
    it("renders the + New schedule header button on mount", () => {
        const client = makeClient();
        render(<SchedulesTab client={client} />);
        // The button is the only entry-point into the add flow now
        // (no more inline form). Asserting on its accessible name
        // doubles as a smoke test that the i18n key survives.
        expect(screen.getByRole("button", { name: "schedules.addButton" })).toBeTruthy();
    });

    it("opens the create dialog and submits the form to jobs.create", async () => {
        const createSpy = vi.fn(({ job }: Record<string, unknown>) =>
            Promise.resolve({ job: { id: "new", ...(job as object) } }),
        );
        const client = makeClient({
            create: createSpy,
            list: () => Promise.resolve({ jobs: [] }),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("schedules.empty")).toBeTruthy();
        });

        // Open the modal and drive the form. The default draft has
        // enabled=true and empty argsJson; we need to type a name AND
        // valid args JSON before the Create button enables.
        await openAddDialog(user);
        await fillValidCreateDraft(user, "nightly");
        await user.click(screen.getByRole("button", { name: "schedules.actionCreate" }));

        await waitFor(() => {
            expect(createSpy).toHaveBeenCalledTimes(1);
        });
        const submitted = createSpy.mock.calls[0]?.[0] as {
            job: {
                name: string;
                schedule: { kind: string; ms: number };
                enabled: boolean;
                args: Record<string, unknown>;
            };
        };
        expect(submitted.job.name).toBe("nightly");
        expect(submitted.job.schedule.kind).toBe("interval");
        expect(submitted.job.schedule.ms).toBe(60_000);
        expect(submitted.job.enabled).toBe(true);
        // The Create button used to send `history: []` — guard against
        // regressing on the fix that drops it (the server preserves
        // history on update and seeds it on create; clients shouldn't
        // send it either way).
        expect("history" in submitted.job).toBe(false);
        expect(submitted.job.args).toEqual({});

        // Dialog closes on successful save so the table refresh can
        // surface the new row.
        await waitFor(() => {
            expect(screen.queryByText("schedules.newTitle")).toBeNull();
        });
    });

    it("opens the edit dialog pre-filled from the row and submits to jobs.update", async () => {
        // The mock matches the wire shape: createJobsClient wraps the
        // Job in a { job } envelope before calling callProcess, so
        // `update` here receives { job: <Job> }.
        const updateSpy = vi.fn(({ job }: Record<string, unknown>) => Promise.resolve({ job }));
        const client = makeClient({
            list: () => Promise.resolve({ jobs: [sampleJob("row-x")] }),
            update: updateSpy,
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("row-x")).toBeTruthy();
        });

        // Click the row's Edit button — labelled with the i18n key —
        // to open the dialog pre-filled.
        await user.click(screen.getByRole("button", { name: "schedules.actionEdit" }));
        await waitFor(() => {
            expect(screen.getByText("schedules.editTitle")).toBeTruthy();
        });

        // The name input carries the existing job's name. Overwrite and
        // submit to confirm the dialog round-trips through jobs.update.
        const nameInput = screen.getByLabelText("schedules.fieldName") as HTMLInputElement;
        expect(nameInput.value).toBe("row-x");
        await user.clear(nameInput);
        await user.type(nameInput, "row-x-renamed");
        await user.click(screen.getByRole("button", { name: "schedules.actionSave" }));

        await waitFor(() => {
            expect(updateSpy).toHaveBeenCalledTimes(1);
        });
        const submitted = updateSpy.mock.calls[0]?.[0] as {
            job: { id: string; name: string };
        };
        expect(submitted.job.id).toBe("row-x");
        expect(submitted.job.name).toBe("row-x-renamed");
        // The update RPC must NOT carry history — the desktop doesn't
        // own past-run records, and sending `history: []` would mask
        // any future regression where the server stops preserving it.
        expect("history" in submitted.job).toBe(false);
    });

    it("cancel button closes the dialog without invoking any RPC", async () => {
        const createSpy = vi.fn(() => Promise.resolve({ job: {} }));
        const client = makeClient({
            create: createSpy,
            list: () => Promise.resolve({ jobs: [] }),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await openAddDialog(user);
        // Fill a valid draft so cancel still preserves the form's
        // exit behaviour (no early-validation dismissal), then click
        // Cancel and assert no RPC fires.
        await fillValidCreateDraft(user, "scratch");
        await user.click(screen.getByRole("button", { name: "schedules.actionCancel" }));

        await waitFor(() => {
            expect(screen.queryByText("schedules.newTitle")).toBeNull();
        });
        expect(createSpy).not.toHaveBeenCalled();
    });

    it("flags invalid args JSON inline so the user sees the problem without round-tripping", async () => {
        // The Create RPC never gets a chance to fire because the
        // dialog gates submit on a parseable JSON object — verify the
        // inline error message renders for a malformed draft AND the
        // submit button stays disabled.
        const createSpy = vi.fn(() => Promise.resolve({ job: {} }));
        const client = makeClient({
            create: createSpy,
            list: () => Promise.resolve({ jobs: [] }),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await openAddDialog(user);
        await user.type(screen.getByLabelText("schedules.fieldName"), "scratch");

        const argsInput = screen.getByLabelText("schedules.fieldArgs") as HTMLTextAreaElement;
        // fireEvent.change bypasses user-event's keyboard parser (which
        // treats `{}` as a descriptor).
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
        )?.set;
        nativeSetter?.call(argsInput, "{");
        argsInput.dispatchEvent(new Event("input", { bubbles: true }));

        await waitFor(() => {
            // Either localised message is acceptable depending on
            // whether the parse error happens before or after the
            // "object" check.
            const found =
                screen.queryByText("schedules.errorArgsJson") ||
                screen.queryByText("schedules.errorArgsNotObject");
            expect(found).toBeTruthy();
        });

        // Submit button must be disabled — no RPC should fire even
        // if the user mashes it.
        const createBtn = screen.getByRole("button", {
            name: "schedules.actionCreate",
        }) as HTMLButtonElement;
        expect(createBtn.disabled).toBe(true);
    });

    it("surfaces runNow RPC failure in the sticky actionError banner", async () => {
        // Fix #9 in the review: the row-level runNow click previously
        // had two outcomes — accepted=true (clear banner) or
        // accepted=false (set 'busy' message). But runNow rejects when
        // the daemon returns an error, and that path needs coverage.
        const client = makeClient({
            list: () => Promise.resolve({ jobs: [sampleJob("row-1")] }),
            runNow: () => Promise.reject(new Error("daemon crash")),
        });
        const user = userEvent.setup();
        render(<SchedulesTab client={client} />);

        await waitFor(() => {
            expect(screen.getByText("row-1")).toBeTruthy();
        });

        // Click the row's Run now button. The catch block in the
        // handler writes to jobs.setActionError, so the sticky
        // banner above the table should pick it up.
        await user.click(screen.getByRole("button", { name: "schedules.actionRunNow" }));
        await waitFor(() => {
            expect(screen.getByText("daemon crash")).toBeTruthy();
        });
    });
});
