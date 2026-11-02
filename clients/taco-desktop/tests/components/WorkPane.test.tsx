import { strict as assert } from "node:assert";
import type { WorkGetResult, WorkSummary } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import * as useI18n from "../../src/i18n/useI18n";
import { WorkPane } from "../../src/views/WorkPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const runningWork: WorkSummary = {
    workId: "w-running",
    revision: 0,
    kind: "subagent",
    title: "Review changes",
    agentType: "reviewer",
    status: "running",
    workspace: "/w",
    sessionId: "parent",
    parentSessionId: "parent",
    childSessionId: "child",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    needsAttention: false,
};

function overview(work: WorkSummary = runningWork) {
    return {
        state: {
            instanceId: "inst-1",
            groups: { running: [work], attention: [], finished: [] },
            nextCursor: undefined,
            loaded: true,
        },
        loading: false,
        loadingMore: false,
        error: null,
        retryingId: null,
        refresh: () => {},
        loadMore: () => {},
        retryDelivery: async () => {},
    };
}

describe("WorkPane result states", () => {
    it("says a running Work has no result yet instead of saying it is unavailable", async () => {
        const workGet = vi.fn(async (): Promise<WorkGetResult> => ({ work: runningWork }));
        render(
            <WorkPane
                client={{ workGet } as never}
                overview={overview()}
                onOpenSession={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));
        await waitFor(() => assert.ok(screen.getByText("work.resultPending")));
        assert.equal(screen.queryByText("work.resultGone"), null);
    });

    it("reloads the open row when its revision advances to a result", async () => {
        const finished = {
            ...runningWork,
            revision: 1,
            status: "completed" as const,
            endedAt: Date.now(),
        };
        const workGet = vi
            .fn()
            .mockResolvedValueOnce({ work: runningWork })
            .mockResolvedValueOnce({ work: finished, resultText: "The full review" });
        const view = render(
            <WorkPane
                client={{ workGet } as never}
                overview={overview()}
                onOpenSession={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));
        await waitFor(() => assert.ok(screen.getByText("work.resultPending")));

        view.rerender(
            <WorkPane
                client={{ workGet } as never}
                overview={overview(finished)}
                onOpenSession={() => {}}
            />,
        );
        await waitFor(() => assert.ok(screen.getByText("The full review")));
        assert.equal(workGet.mock.calls.length, 2);
    });
});
