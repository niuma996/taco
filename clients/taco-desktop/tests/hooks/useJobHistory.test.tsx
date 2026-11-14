import type { Job, JobHistoryEntry, WorkListResult, WorkSummary } from "@taco-ai/protocol";
import { focusManager } from "@tanstack/react-query";
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleHistoryDialog } from "../../src/components/settings/ScheduleHistoryDialog";
import { useJobHistory } from "../../src/hooks/useJobHistory";
import { useManagementQuerySync } from "../../src/hooks/useManagementQuerySync";
import { useWorkDetail } from "../../src/hooks/useWorkDetail";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { onWorkChangedEvent } from "../../src/lib/workEvents";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
});
const job: Job = {
    id: "test-job",
    name: "Test job",
    schedule: { kind: "interval", ms: 10000 },
    command: "agent.invoke",
    args: {},
    enabled: true,
    run_on_startup: false,
    history: [],
};
function fixture() {
    const history = vi.fn(async (): Promise<{ history: JobHistoryEntry[] }> => ({ history: [] }));
    const workList = vi.fn(
        async (): Promise<WorkListResult> => ({ instanceId: "one", active: [], terminal: [] }),
    );
    const client = {
        callProcess: history,
        workList,
        onConnectionReady: vi.fn(() => () => {}),
    } as unknown as TacoClient;
    return { client, history, workList };
}

describe("shared job history", () => {
    it("deduplicates history and job-scoped Work reads between dialogs", async () => {
        const h = fixture();
        render(
            <>
                <ScheduleHistoryDialog
                    client={h.client}
                    job={job}
                    onClose={() => {}}
                    onOpenSession={() => {}}
                />
                <ScheduleHistoryDialog
                    client={h.client}
                    job={job}
                    onClose={() => {}}
                    onOpenSession={() => {}}
                />
            </>,
            queryWrapper(),
        );
        await waitFor(() => expect(h.workList).toHaveBeenCalled());
        await act(async () => {});
        expect(h.history).toHaveBeenCalledTimes(1);
        expect(h.workList).toHaveBeenCalledTimes(1);
    });
    it("polls every ten seconds only while open", async () => {
        vi.useFakeTimers();
        const h = fixture();
        const view = renderHook(({ id }) => useJobHistory(h.client, id), {
            ...queryWrapper(),
            initialProps: { id: job.id as string | undefined },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(view.result.current.history).toEqual([]);
        expect(h.history).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(h.history).toHaveBeenCalledTimes(2);
        expect(h.workList).toHaveBeenCalledTimes(2);
        view.rerender({ id: undefined });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(h.history).toHaveBeenCalledTimes(2);
        expect(view.result.current.history).toBeNull();
        view.unmount();
    });

    it("refreshes after Work pushes and rejects a late response from another job", async () => {
        const h = fixture();
        let resolve!: (result: { history: JobHistoryEntry[] }) => void;
        h.history.mockReturnValueOnce(
            new Promise((yes) => {
                resolve = yes;
            }),
        );
        const view = renderHook(({ id }) => useJobHistory(h.client, id), {
            ...queryWrapper(),
            initialProps: { id: "old" },
        });
        view.rerender({ id: "new" });
        await waitFor(() => expect(view.result.current.history).toEqual([]));
        await act(async () => resolve({ history: [{ started_at: "old", status: "err" }] }));
        expect(view.result.current.history).toEqual([]);
        h.history.mockResolvedValue({ history: [{ started_at: "fresh", status: "ok" }] });
        act(() => onWorkChangedEvent());
        await waitFor(() => expect(view.result.current.history?.[0]?.started_at).toBe("fresh"));
        view.unmount();
        const count = h.history.mock.calls.length;
        act(() => onWorkChangedEvent());
        await act(async () => {});
        expect(h.history).toHaveBeenCalledTimes(count);
    });

    it("uses the root reconnect subscription to replace a pending initial request", async () => {
        const h = fixture();
        const options = queryWrapper();
        let ready!: () => void;
        h.client.onConnectionReady = (callback) => {
            ready = () => callback("new-instance");
            return () => {};
        };
        let resolve!: (value: { history: JobHistoryEntry[] }) => void;
        h.history.mockReturnValueOnce(
            new Promise((yes) => {
                resolve = yes;
            }),
        );
        renderHook(() => useManagementQuerySync(h.client), options);
        const view = renderHook(() => useJobHistory(h.client, job.id), options);
        act(() => ready());
        await waitFor(() => expect(view.result.current.history).toEqual([]));
        await act(async () => resolve({ history: [{ started_at: "obsolete", status: "err" }] }));
        expect(view.result.current.history).toEqual([]);
        expect(h.history).toHaveBeenCalledTimes(2);
    });

    it("shares revision-specific Work details with the Work page reader", async () => {
        const h = fixture();
        const options = queryWrapper();
        const work: WorkSummary = {
            workId: "work-1",
            revision: 1,
            kind: "scheduled",
            title: "Run",
            status: "completed",
            sessionId: "session",
            parentSessionId: "session",
            createdAt: 1,
            updatedAt: 1,
            needsAttention: false,
        };
        h.history.mockResolvedValue({
            history: [
                { started_at: "2026-01-01T00:00:00.000Z", status: "ok", workId: work.workId },
            ],
        });
        h.workList.mockResolvedValue({ instanceId: "one", active: [], terminal: [work] });
        const workGet = vi.fn(async () => ({ work, resultText: "Shared saved answer" }));
        Object.assign(h.client, { workGet });
        const reader = renderHook(
            () => useWorkDetail(h.client, work.workId, work.revision),
            options,
        );
        await waitFor(() => expect(reader.result.current?.resultText).toBe("Shared saved answer"));
        render(
            <ScheduleHistoryDialog
                client={h.client}
                job={job}
                onClose={() => {}}
                onOpenSession={() => {}}
            />,
            options,
        );
        await waitFor(() => expect(document.querySelector(".work-item-toggle")).toBeTruthy());
        fireEvent.click(document.querySelector(".work-item-toggle") as HTMLButtonElement);
        expect(await screen.findByText("Shared saved answer")).toBeTruthy();
        expect(workGet).toHaveBeenCalledTimes(1);
        h.workList.mockResolvedValue({
            instanceId: "one",
            active: [],
            terminal: [{ ...work, revision: 2 }],
        });
        workGet.mockResolvedValue({
            work: { ...work, revision: 2 },
            resultText: "New saved answer",
        });
        act(() => onWorkChangedEvent());
        expect(await screen.findByText("New saved answer")).toBeTruthy();
        expect(workGet).toHaveBeenCalledTimes(2);
    });
    it("reports history failures and clears the banner on the next successful poll", async () => {
        vi.useFakeTimers();
        const h = fixture();
        h.history.mockRejectedValueOnce("history unavailable");
        const view = renderHook(() => useJobHistory(h.client, job.id), queryWrapper());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(view.result.current.error).toBe("history unavailable");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(view.result.current.error).toBeNull();
        expect(view.result.current.history).toEqual([]);
    });

    it("does not reopen an expanded run after the same dialog is closed and reopened", async () => {
        const h = fixture();
        const work: WorkSummary = {
            workId: "work-1",
            revision: 1,
            kind: "scheduled",
            title: "Run",
            status: "completed",
            sessionId: "session",
            parentSessionId: "session",
            createdAt: 1,
            updatedAt: 1,
            needsAttention: false,
        };
        h.history.mockResolvedValue({
            history: [
                { started_at: "2026-01-01T00:00:00.000Z", status: "ok", workId: work.workId },
            ],
        });
        h.workList.mockResolvedValue({ instanceId: "one", active: [], terminal: [work] });
        Object.assign(h.client, { workGet: vi.fn(async () => ({ work, resultText: "Answer" })) });
        const props = { client: h.client, onClose: () => {}, onOpenSession: () => {} };
        const view = render(<ScheduleHistoryDialog {...props} job={job} />, queryWrapper());
        await waitFor(() => expect(document.querySelector(".work-item-toggle")).toBeTruthy());
        fireEvent.click(document.querySelector(".work-item-toggle") as HTMLButtonElement);
        expect(await screen.findByText("Answer")).toBeTruthy();
        view.rerender(<ScheduleHistoryDialog {...props} job={null} />);
        view.rerender(<ScheduleHistoryDialog {...props} job={job} />);
        await waitFor(() => expect(document.querySelector(".work-item-toggle")).toBeTruthy());
        expect(document.querySelector(".work-item-toggle")?.getAttribute("aria-expanded")).toBe(
            "false",
        );
    });
    it("keeps polling a still-open dialog while the application is unfocused", async () => {
        vi.useFakeTimers();
        focusManager.setFocused(false);
        const h = fixture();
        renderHook(() => useJobHistory(h.client, job.id), queryWrapper());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(h.history).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(h.history).toHaveBeenCalledTimes(2);
        expect(h.workList).toHaveBeenCalledTimes(2);
    });
});
