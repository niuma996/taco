/**
 * ScheduleHistoryDialog — a job's runs, read from its history and joined with
 * the Work each agent fire left behind.
 *
 * The cases that matter are the ones the history alone gets wrong: a fire
 * that timed out while its turn kept going, and a prompt merged into a turn
 * already running. Both must read from the Work, not from `status`.
 */

import { strict as assert } from "node:assert";
import type { Job, JobHistoryEntry, WorkSummary } from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import {
    entryDurationMs,
    runState,
    ScheduleHistoryDialog,
} from "../../../src/components/settings/ScheduleHistoryDialog";
import * as useI18n from "../../../src/i18n/useI18n";
import type { TacoClient } from "../../../src/lib/clients/tacoClient";
import { onWorkChangedEvent } from "../../../src/lib/workEvents";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const job: Job = {
    id: "daily",
    name: "Daily digest",
    schedule: { kind: "interval", ms: 60_000 },
    command: "agent.invoke",
    args: { workspace: "/w", prompt: "summarize" },
    enabled: true,
    run_on_startup: false,
};

function entry(over: Partial<JobHistoryEntry> = {}): JobHistoryEntry {
    return {
        started_at: "2026-11-03T08:00:00.000Z",
        ended_at: "2026-11-03T08:00:42.000Z",
        status: "ok",
        ...over,
    };
}

function work(over: Partial<WorkSummary> = {}): WorkSummary {
    return {
        workId: "w-1",
        revision: 1,
        kind: "scheduled",
        title: "Daily digest",
        jobId: "daily",
        status: "completed",
        workspace: "/w",
        sessionId: "sched-pin-daily",
        parentSessionId: "sched-pin-daily",
        createdAt: 1,
        updatedAt: 2,
        needsAttention: false,
        ...over,
    };
}

function fakeClient(scripts: {
    history: () => JobHistoryEntry[];
    works: () => WorkSummary[];
    resultText?: string;
}) {
    const calls: string[] = [];
    let onConnectionReady =
        (_fn: () => void): (() => void) =>
        () =>
            undefined;
    const client = {
        onConnectionReady: (fn: () => void) => onConnectionReady(fn),
        callProcess: async (method: string) => {
            calls.push(method);
            if (method === "jobs.history") return { history: scripts.history() };
            throw new Error(`unexpected ${method}`);
        },
        workList: vi.fn(async (params: { jobId?: string }) => {
            calls.push(`work.list:${params.jobId}`);
            const all = scripts.works();
            return {
                instanceId: "i",
                active: all.filter((w) => w.status === "running"),
                terminal: all.filter((w) => w.status !== "running"),
            };
        }),
        workGet: vi.fn(async ({ workId }: { workId: string }) => ({
            work: scripts.works().find((w) => w.workId === workId) ?? null,
            ...(scripts.resultText !== undefined ? { resultText: scripts.resultText } : {}),
        })),
    };
    const readyHandlers = new Set<() => void>();
    onConnectionReady = (fn: () => void) => {
        readyHandlers.add(fn);
        return () => readyHandlers.delete(fn);
    };
    return {
        client: client as unknown as TacoClient,
        calls,
        raw: client,
        reconnect: () => {
            for (const fn of readyHandlers) fn();
        },
    };
}

describe("runState", () => {
    it("trusts the Work over the fire's status", () => {
        assert.equal(
            runState(entry({ status: "err" }), work({ status: "running" })),
            "timedOutRunning",
        );
        assert.equal(
            runState(entry({ status: "err" }), work({ status: "completed" })),
            "completed",
        );
        assert.equal(runState(entry({ status: "ok" }), work({ status: "failed" })), "failed");
        assert.equal(runState(entry(), work({ status: "completed", reason: "merged" })), "merged");
    });

    it("falls back to the history entry when there is no Work", () => {
        assert.equal(runState(entry({ status: "ok" }), undefined), "completed");
        assert.equal(runState(entry({ status: "err" }), undefined), "failed");
        assert.equal(
            runState(entry({ status: "running", ended_at: undefined }), undefined),
            "running",
        );
    });

    it("measures a finished entry and leaves a running one unmeasured", () => {
        assert.equal(entryDurationMs(entry()), 42_000);
        assert.equal(entryDurationMs(entry({ ended_at: undefined })), undefined);
    });
});

describe("ScheduleHistoryDialog", () => {
    it("loads the job's history and only that job's Works", async () => {
        const { client, calls } = fakeClient({
            history: () => [entry({ workId: "w-1" })],
            works: () => [work()],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.completed")));
        assert.ok(calls.includes("jobs.history"));
        assert.ok(calls.includes("work.list:daily"));
    });

    it("shows a timed-out fire whose turn is still running as running, not failed", async () => {
        const { client } = fakeClient({
            history: () => [
                entry({ status: "err", error: "fire timed out after 300000ms", workId: "w-1" }),
            ],
            works: () => [work({ status: "running" })],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.timedOutRunning")));
        assert.ok(screen.getByText("schedules.history.timedOutRunning"));
        assert.equal(screen.queryByText("schedules.history.state.failed"), null);
        assert.equal(screen.queryByText(/fire timed out/), null);
    });

    it("explains a merged fire instead of showing a missing answer", async () => {
        const { client } = fakeClient({
            history: () => [entry({ workId: "w-1" })],
            works: () => [work({ reason: "merged" })],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.merged")));
        assert.ok(screen.getByText("schedules.history.mergedHint"));
    });

    it("opens a run's answer and its session", async () => {
        const opened: [string, string][] = [];
        const { client } = fakeClient({
            history: () => [entry({ workId: "w-1" })],
            works: () => [work()],
            resultText: "Nothing new overnight.",
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={(w, s) => opened.push([w, s])}
            />,
        );
        const toggle = await screen.findByRole("button", { expanded: false });
        fireEvent.click(toggle);
        await waitFor(() => assert.ok(screen.getByText("Nothing new overnight.")));
        fireEvent.click(screen.getByRole("button", { name: /work.openSession/ }));
        assert.deepEqual(opened, [["/w", "sched-pin-daily"]]);
    });

    it("shows a built-in run's summary and offers nothing to open", async () => {
        const { client } = fakeClient({
            history: () => [entry({ summary: "merged 12→4" })],
            works: () => [],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("merged 12→4")));
        assert.equal(screen.queryByRole("button", { name: /work.openSession/ }), null);
    });

    it("re-reads when a Work changes, so a run that finishes updates in place", async () => {
        let status: WorkSummary["status"] = "running";
        const { client } = fakeClient({
            history: () => [entry({ status: "running", ended_at: undefined, workId: "w-1" })],
            works: () => [work({ status })],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.running")));
        status = "completed";
        act(() => onWorkChangedEvent());
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.completed")));
    });

    it("re-reads after the connection is restored", async () => {
        let runs = 0;
        const { client, reconnect } = fakeClient({
            history: () => {
                runs += 1;
                return runs === 1
                    ? [entry({ status: "err", error: "no route", workId: undefined })]
                    : [entry({ workId: "w-1" })];
            },
            works: () => [work()],
        });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.failed")));
        reconnect();
        await waitFor(() => assert.ok(screen.getByText("schedules.history.state.completed")));
    });

    it("re-reads on a timer while open, for changes nothing pushes", async () => {
        vi.useFakeTimers();
        try {
            let runs = 0;
            const { client } = fakeClient({
                history: () => {
                    runs += 1;
                    return runs === 1
                        ? [entry({ status: "running", ended_at: undefined, workId: "w-1" })]
                        : [entry({ workId: "w-1" })];
                },
                works: () => [work({ status: runs === 1 ? "running" : "completed" })],
            });
            render(
                <ScheduleHistoryDialog
                    client={client}
                    job={job}
                    onClose={() => {}}
                    onOpenSession={() => {}}
                />,
            );
            await vi.waitFor(() => assert.ok(screen.getByText("schedules.history.state.running")));
            await act(async () => {
                vi.advanceTimersByTime(10_000);
            });
            await vi.waitFor(() =>
                assert.ok(screen.getByText("schedules.history.state.completed")),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("says so when the job has never run", async () => {
        const { client } = fakeClient({ history: () => [], works: () => [] });
        render(
            <ScheduleHistoryDialog
                client={client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("schedules.history.empty")));
    });
});
