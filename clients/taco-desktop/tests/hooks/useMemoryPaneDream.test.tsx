import type { Job, MemoryListResult } from "@taco-ai/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMemoryPane } from "../../src/hooks/useMemoryPane";

const listResult: MemoryListResult = {
    enabled: true,
    memoryContent: "# Memory\n",
    memoryHash: "hash",
    topics: [],
    dreamScheduled: true,
};

const dreamJob: Job = {
    id: "memory-dream",
    name: "Memory consolidation",
    schedule: { kind: "cron", expr: "17 4 * * *" },
    command: "memory.dream",
    args: { minHours: 24 },
    enabled: true,
    run_on_startup: true,
    builtin: true,
    history: [{ started_at: "2026-10-25T00:00:00.000Z", status: "ok" }],
};

function makeClient(runResult: unknown = { status: "previewed", preview: { id: "preview-1" } }) {
    const memoryList = vi.fn(async () => listResult);
    const memoryDreamRun = vi.fn(async () => runResult);
    const memoryDreamApply = vi.fn(async () => ({
        report: { id: "report-1", appliedAt: "now", counts: {}, skipped: 0 },
    }));
    const memoryDreamUndo = vi.fn(async () => ({ conflicts: ["edited-topic"] }));
    const callProcess = vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "jobs.get") return { job: dreamJob };
        if (method === "jobs.update") return { job: params.job };
        throw new Error(`unexpected method ${method}`);
    });
    return {
        client: {
            memoryList,
            memoryDreamRun,
            memoryDreamApply,
            memoryDreamUndo,
            callProcess,
        },
        memoryList,
        memoryDreamRun,
        memoryDreamApply,
        memoryDreamUndo,
        callProcess,
    };
}

function renderMemory(client: ReturnType<typeof makeClient>["client"], notify = vi.fn()) {
    return renderHook(() => useMemoryPane(client as never, true, "/ws", (key) => key, notify));
}

describe("useMemoryPane dream actions", () => {
    it("runs a preview for the active workspace and refreshes the list", async () => {
        const fake = makeClient();
        const { result } = renderMemory(fake.client);
        await waitFor(() => expect(fake.memoryList).toHaveBeenCalledTimes(1));

        await act(async () => {
            await result.current.handleDreamRun();
        });

        expect(fake.memoryDreamRun).toHaveBeenCalledWith("/ws");
        expect(fake.memoryList).toHaveBeenCalledTimes(2);
        expect(result.current.dreamBusy).toBeNull();
    });

    it("applies the exact preview id supplied by the pane", async () => {
        const fake = makeClient();
        const { result } = renderMemory(fake.client);
        await waitFor(() => expect(fake.memoryList).toHaveBeenCalledTimes(1));

        await act(async () => {
            await result.current.handleDreamApply("preview-1");
        });
        expect(fake.memoryDreamApply).toHaveBeenCalledWith("/ws", "preview-1");
    });

    it("toggles the built-in job without sending its history", async () => {
        const fake = makeClient();
        const { result } = renderMemory(fake.client);
        await waitFor(() => expect(fake.memoryList).toHaveBeenCalledTimes(1));

        await act(async () => {
            await result.current.handleDreamScheduleToggle(false);
        });

        const update = fake.callProcess.mock.calls.find(([method]) => method === "jobs.update");
        expect(update).toBeTruthy();
        const sent = update?.[1].job as Job;
        expect(sent.enabled).toBe(false);
        expect(sent.builtin).toBe(true);
        expect(sent.history).toBeUndefined();
        expect(sent.command).toBe("memory.dream");
    });

    it("reports a failed model run as an error, not as an empty result", async () => {
        const fake = makeClient({ status: "failed", reason: "model unavailable" });
        const notify = vi.fn();
        const { result } = renderMemory(fake.client, notify);
        await waitFor(() => expect(fake.memoryList).toHaveBeenCalledTimes(1));

        await act(async () => {
            await result.current.handleDreamRun();
        });
        expect(notify).toHaveBeenCalledWith("memory.dream.error.run: model unavailable");
    });

    it("surfaces undo conflicts without throwing away the refreshed state", async () => {
        const fake = makeClient();
        const notify = vi.fn();
        const { result } = renderMemory(fake.client, notify);
        await waitFor(() => expect(fake.memoryList).toHaveBeenCalledTimes(1));

        await act(async () => {
            await result.current.handleDreamUndo("report-1");
        });
        expect(fake.memoryDreamUndo).toHaveBeenCalledWith("/ws", "report-1");
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("edited-topic"));
        expect(fake.memoryList).toHaveBeenCalledTimes(2);
    });
});
