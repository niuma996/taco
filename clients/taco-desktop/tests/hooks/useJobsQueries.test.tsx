import type { Job } from "@taco-ai/protocol";
import { useQuery } from "@tanstack/react-query";
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
import { SchedulesTab } from "../../src/components/settings/SchedulesTab";
import { useMemoryPane } from "../../src/hooks/useMemoryPane";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { jobQuery, jobsListQuery } from "../../src/lib/queries/jobsQueries";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(cleanup);
const job: Job = {
    id: "memory-dream",
    name: "Memory consolidation",
    schedule: { kind: "cron", expr: "17 4 * * *" },
    command: "memory.dream",
    args: { minHours: 24 },
    enabled: true,
    run_on_startup: true,
    builtin: true,
    history: [],
};
function fixture() {
    let current = job;
    const callProcess = vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "jobs.list") return { jobs: [current] };
        if (method === "jobs.get") return { job: current };
        if (method === "jobs.update") {
            current = params.job as Job;
            return { job: current };
        }
        throw new Error(`unexpected ${method}`);
    });
    const client = {
        callProcess,
        memoryList: vi.fn(async () => ({
            enabled: true,
            memoryContent: "",
            memoryHash: "hash",
            topics: [],
            dreamScheduled: current.enabled,
        })),
    } as unknown as TacoClient;
    return { client, callProcess };
}

describe("shared jobs queries", () => {
    it("deduplicates built-in job reads across Memory readers", async () => {
        const h = fixture();
        const options = queryWrapper();
        const one = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        const two = renderHook(
            () => useMemoryPane(h.client, true, "/b", (key) => key, vi.fn()),
            options,
        );
        await waitFor(() => expect(two.result.current.dreamConfig?.minHours).toBe(24));
        expect(one.result.current.dreamConfig?.minHours).toBe(24);
        expect(h.callProcess.mock.calls.filter(([method]) => method === "jobs.get")).toHaveLength(
            1,
        );
    });

    it("Memory updates the Schedules list and every mounted dream configuration", async () => {
        const h = fixture();
        const options = queryWrapper();
        render(<SchedulesTab client={h.client} onOpenSession={() => {}} />, options);
        const one = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        const two = renderHook(
            () => useMemoryPane(h.client, true, "/b", (key) => key, vi.fn()),
            options,
        );
        await waitFor(() => expect(two.result.current.dreamConfig?.minHours).toBe(24));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
        );
        await act(async () => one.result.current.handleDreamScheduleToggle(false));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
        );
        await act(async () =>
            one.result.current.handleDreamConfigSave({
                minHours: 48,
                staleDays: 90,
                staleDaysDurable: 180,
                archiveCleanupEnabled: false,
                archiveRetentionDays: 7,
            }),
        );
        await waitFor(() => expect(two.result.current.dreamConfig?.minHours).toBe(48));
    });
    it("a schedule table toggle refreshes Memory's shared job state", async () => {
        const h = fixture();
        const options = queryWrapper();
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        render(<SchedulesTab client={h.client} onOpenSession={() => {}} />, options);
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(true));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(false));
    });

    it("does not replace confirmed job state when a Memory save fails", async () => {
        const h = fixture();
        const options = queryWrapper();
        const notify = vi.fn();
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, notify),
            options,
        );
        await waitFor(() => expect(memory.result.current.dreamConfig?.minHours).toBe(24));
        h.callProcess.mockRejectedValueOnce(new Error("configuration unavailable"));
        let saved: boolean | undefined;
        await act(async () => {
            saved = await memory.result.current.handleDreamConfigSave({
                minHours: 48,
                staleDays: 90,
                staleDaysDurable: 180,
                archiveCleanupEnabled: false,
                archiveRetentionDays: 7,
            });
        });
        expect(saved).toBe(false);
        expect(memory.result.current.dreamConfig?.minHours).toBe(24);
        expect(notify).toHaveBeenCalledWith(
            "memory.dream.error.settings: configuration unavailable",
        );
    });
    it("keeps server-confirmed configuration when a subsequent read fails", async () => {
        const h = fixture();
        const options = queryWrapper();
        const original = h.callProcess.getMockImplementation();
        if (!original) throw new Error("missing transport");
        h.callProcess.mockImplementation(async (method, params) => {
            const result = await original(method, params);
            if (method === "jobs.update")
                h.callProcess.mockRejectedValueOnce(new Error("read unavailable"));
            return result;
        });
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        await waitFor(() => expect(memory.result.current.dreamConfig?.minHours).toBe(24));
        await act(async () =>
            memory.result.current.handleDreamConfigSave({
                minHours: 48,
                staleDays: 90,
                staleDaysDurable: 180,
                archiveCleanupEnabled: false,
                archiveRetentionDays: 7,
            }),
        );
        expect(
            options.queryClient.getQueryData(jobQuery(h.client, job.id).queryKey)?.args.minHours,
        ).toBe(48);
        await waitFor(() => expect(memory.result.current.dreamConfig?.minHours).toBe(48));
    });

    it("does not mask a fresh Memory snapshot with an older cached schedule flag", async () => {
        const h = fixture();
        const options = queryWrapper();
        options.queryClient.setQueryData(jobQuery(h.client, job.id).queryKey, job);
        const memory = renderHook(
            ({ active }) => useMemoryPane(h.client, active, "/a", (key) => key, vi.fn()),
            { ...options, initialProps: { active: true } },
        );
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(true));
        memory.rerender({ active: false });
        Object.assign(h.client, {
            memoryList: vi.fn(async () => ({
                enabled: true,
                memoryContent: "",
                memoryHash: "hash",
                topics: [],
                dreamScheduled: false,
            })),
        });
        await act(async () => memory.result.current.loadMemory());
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(false));
    });
    it("a delayed Memory refresh cannot undo a newer confirmed schedule toggle", async () => {
        const h = fixture();
        const options = queryWrapper();
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        render(<SchedulesTab client={h.client} onOpenSession={() => {}} />, options);
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(true));
        let resolve!: (value: {
            enabled: boolean;
            memoryContent: string;
            memoryHash: string;
            topics: [];
            dreamScheduled: boolean;
        }) => void;
        Object.assign(h.client, {
            memoryList: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((yes) => {
                            resolve = yes;
                        }),
                )
                .mockResolvedValue({
                    enabled: true,
                    memoryContent: "",
                    memoryHash: "hash",
                    topics: [],
                    dreamScheduled: false,
                }),
        });
        act(() => memory.result.current.loadMemory());
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(false));
        await act(async () =>
            resolve({
                enabled: true,
                memoryContent: "",
                memoryHash: "hash",
                topics: [],
                dreamScheduled: true,
            }),
        );
        expect(memory.result.current.memoryData?.dreamScheduled).toBe(false);
    });
    it("isolates job data belonging to another client and refreshes enabled readers after invalidation", async () => {
        const first = fixture();
        const second = fixture();
        const options = queryWrapper();
        second.callProcess.mockImplementation(async (method) =>
            method === "jobs.list"
                ? { jobs: [{ ...job, args: { minHours: 72 } }] }
                : { job: { ...job, args: { minHours: 72 } } },
        );
        const one = renderHook(() => useQuery(jobQuery(first.client, job.id)), options);
        const two = renderHook(() => useQuery(jobQuery(second.client, job.id)), options);
        await waitFor(() => expect(two.result.current.data?.args.minHours).toBe(72));
        expect(one.result.current.data?.args.minHours).toBe(24);
        const table = renderHook(() => useQuery(jobsListQuery(second.client)), options);
        await waitFor(() => expect(table.result.current.data?.[0]?.args.minHours).toBe(72));
    });
    it("an initial Memory snapshot cannot undo a toggle confirmed before the first job read", async () => {
        const h = fixture();
        const options = queryWrapper();
        let resolveMemory!: (value: {
            enabled: boolean;
            memoryContent: string;
            memoryHash: string;
            topics: [];
            dreamScheduled: boolean;
        }) => void;
        Object.assign(h.client, {
            memoryList: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((yes) => {
                            resolveMemory = yes;
                        }),
                )
                .mockResolvedValue({
                    enabled: true,
                    memoryContent: "",
                    memoryHash: "hash",
                    topics: [],
                    dreamScheduled: false,
                }),
        });
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        render(<SchedulesTab client={h.client} onOpenSession={() => {}} />, options);
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
        );
        await act(async () =>
            resolveMemory({
                enabled: true,
                memoryContent: "",
                memoryHash: "hash",
                topics: [],
                dreamScheduled: true,
            }),
        );
        await waitFor(() => expect(memory.result.current.memoryData).not.toBeNull());
        expect(memory.result.current.memoryData?.dreamScheduled).toBe(false);
    });
    it("a fresh initial Memory snapshot outranks an older in-flight job read", async () => {
        const h = fixture();
        const options = queryWrapper();
        const original = h.callProcess.getMockImplementation();
        if (!original) throw new Error("missing transport");
        let resolveJob!: (value: { job: Job }) => void;
        h.callProcess.mockImplementation((method, params) =>
            method === "jobs.get"
                ? new Promise((resolve) => {
                      resolveJob = resolve;
                  })
                : original(method, params),
        );
        Object.assign(h.client, {
            memoryList: vi.fn(async () => ({
                enabled: true,
                memoryContent: "",
                memoryHash: "hash",
                topics: [],
                dreamScheduled: false,
            })),
        });
        const memory = renderHook(
            () => useMemoryPane(h.client, true, "/a", (key) => key, vi.fn()),
            options,
        );
        await waitFor(() => expect(memory.result.current.memoryData?.dreamScheduled).toBe(false));
        await act(async () => resolveJob({ job }));
        await waitFor(() => expect(memory.result.current.dreamConfig?.minHours).toBe(24));
        expect(memory.result.current.memoryData?.dreamScheduled).toBe(false);
    });
});
