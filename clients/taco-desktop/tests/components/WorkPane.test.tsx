import { strict as assert } from "node:assert";
import type {
    WorkCancelResult,
    WorkDeleteResult,
    WorkGetResult,
    WorkSummary,
} from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    it("opens a Work with its own workspace and session as one target", () => {
        const onOpenSession = vi.fn();
        render(
            <WorkPane
                client={{} as never}
                overview={overview({
                    ...runningWork,
                    workspace: "/other-project",
                    sessionId: "other-session",
                })}
                onOpenSession={onOpenSession}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "work.openSession" }));
        assert.deepEqual(onOpenSession.mock.calls, [
            [
                {
                    workspace: "/other-project",
                    sessionId: "other-session",
                },
            ],
        ]);
    });

    for (const sessionState of ["deleted", "unavailable"] as const) {
        it(`disables navigation to a ${sessionState} target while keeping its result`, async () => {
            const work = { ...runningWork, sessionState, status: "completed" as const };
            const onOpenSession = vi.fn();
            render(
                <WorkPane
                    client={
                        { workGet: async () => ({ work, resultText: "Saved findings" }) } as never
                    }
                    overview={overview(work)}
                    onOpenSession={onOpenSession}
                />,
            );
            const open = screen.getByRole("button", {
                name: "work.openSession",
            }) as HTMLButtonElement;
            assert.equal(open.disabled, true);
            assert.equal(
                open.title,
                `work.openSession${sessionState === "deleted" ? "Deleted" : "Unavailable"}`,
            );
            fireEvent.click(open);
            assert.equal(onOpenSession.mock.calls.length, 0);
            fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));
            await waitFor(() => assert.ok(screen.getByText("Saved findings")));
        });
    }

    it("keeps records without a workspace unavailable", () => {
        render(
            <WorkPane
                client={{} as never}
                overview={overview({ ...runningWork, workspace: undefined })}
                onOpenSession={() => {}}
            />,
        );
        assert.equal(
            (screen.getByRole("button", { name: "work.openSession" }) as HTMLButtonElement)
                .disabled,
            true,
        );
    });

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

it("shows waiting attention, bounds its description and opens the actual waiting session", async () => {
    const work: WorkSummary = {
        ...runningWork,
        status: "waiting",
        needsAttention: true,
        waiting: {
            toolCallId: "ask",
            toolName: "askUser",
            sessionId: "child",
            description: "x".repeat(1000),
        },
    };
    const onOpenSession = vi.fn();
    render(
        <WorkPane
            client={{ workGet: async () => ({ work }) } as never}
            overview={{
                ...overview(work),
                state: {
                    ...overview(work).state,
                    groups: { running: [], attention: [work], finished: [] },
                },
            }}
            onOpenSession={onOpenSession}
        />,
    );
    assert.ok(screen.getByText("work.group.attention"));
    assert.ok(screen.getByText("work.status.waiting").className.includes("work-status--warn"));
    const description = document.querySelector(".work-item-waiting");
    assert.ok(description);
    assert.ok((description.textContent?.length ?? 0) <= 240);
    fireEvent.click(screen.getByRole("button", { name: "work.openSession" }));
    assert.deepEqual(onOpenSession.mock.calls, [[{ workspace: "/w", sessionId: "child" }]]);
    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));
    await waitFor(() => assert.ok(screen.getByText("work.resultPending")));
});

function actionClient(methods = ["work.cancel", "work.delete"]) {
    return {
        workCancel: vi.fn(
            async (_params: { workId: string; attemptId: string }): Promise<WorkCancelResult> => ({
                outcome: "accepted" as const,
                newlyRequested: true,
            }),
        ),
        workDelete: vi.fn(
            async (_params: { workId: string }): Promise<WorkDeleteResult> => ({
                outcome: "deleted" as const,
            }),
        ),
        getServerCapabilities: () => ({ methods, pushes: [] }),
    };
}

it("localizes permission waiting instead of displaying the server description", () => {
    render(
        <WorkPane
            client={{} as never}
            overview={overview({
                ...runningWork,
                status: "waiting",
                waiting: {
                    toolName: "permission",
                    toolCallId: "p",
                    sessionId: "parent",
                    description: "Command approval required",
                },
            })}
            onOpenSession={() => {}}
        />,
    );
    assert.ok(screen.getByText("work.permissionRequired"));
    assert.equal(screen.queryByText("Command approval required"), null);
});

it("hides control actions for legacy rows without attempt fields", () => {
    render(
        <WorkPane
            client={actionClient() as never}
            overview={overview()}
            onOpenSession={() => {}}
        />,
    );
    assert.equal(screen.queryByRole("button", { name: "work.cancel" }), null);
    assert.equal(screen.queryByRole("button", { name: "work.delete" }) === null, true);
});

it("cancels the displayed attempt and refreshes after acceptance", async () => {
    const client = actionClient();
    const view = {
        ...overview({ ...runningWork, attemptId: "attempt-shown", canCancel: true }),
        refresh: vi.fn(),
    };
    render(<WorkPane client={client as never} overview={view} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "work.cancel" }));
    await waitFor(() => assert.equal(client.workCancel.mock.calls.length, 1));
    assert.deepEqual(client.workCancel.mock.calls[0], [
        { workId: runningWork.workId, attemptId: "attempt-shown" },
    ]);
    await waitFor(() => assert.equal(view.refresh.mock.calls.length, 1));
    assert.equal(client.workDelete.mock.calls.length, 0);
});

it("does not submit twice while cancellation is pending", async () => {
    const client = actionClient();
    let finish!: (value: { outcome: "accepted"; newlyRequested: boolean }) => void;
    client.workCancel.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    render(
        <WorkPane
            client={client as never}
            overview={overview({ ...runningWork, attemptId: "a", canCancel: true })}
            onOpenSession={() => {}}
        />,
    );
    const button = screen.getByRole("button", { name: "work.cancel" }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    assert.equal(button.disabled, true);
    assert.equal(client.workCancel.mock.calls.length, 1);
    finish({ outcome: "accepted", newlyRequested: true });
    await waitFor(() => assert.equal(button.disabled, false));
});

it("disables cancellation when the daemon does not advertise the method", () => {
    const client = actionClient([]);
    render(
        <WorkPane
            client={client as never}
            overview={overview({ ...runningWork, attemptId: "a", canCancel: true })}
            onOpenSession={() => {}}
        />,
    );
    const button = screen.getByRole("button", { name: "work.cancel" }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    fireEvent.click(button);
    assert.equal(client.workCancel.mock.calls.length, 0);
});

for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    it(`deletes a ${status} record and refreshes`, async () => {
        const client = actionClient();
        const view = {
            ...overview({ ...runningWork, status, attemptId: "a", canCancel: false }),
            refresh: vi.fn(),
        };
        render(<WorkPane client={client as never} overview={view} onOpenSession={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: "work.delete" }));
        await waitFor(() =>
            assert.deepEqual(client.workDelete.mock.calls, [[{ workId: runningWork.workId }]]),
        );
        await waitFor(() => assert.equal(view.refresh.mock.calls.length, 1));
        assert.equal(screen.queryByRole("button", { name: "work.cancel" }), null);
    });
}

it("keeps waiting records out of deletion and gates terminal deletion by method", () => {
    const client = actionClient([]);
    const view = render(
        <WorkPane
            client={client as never}
            overview={overview({
                ...runningWork,
                status: "waiting",
                attemptId: "a",
                canCancel: true,
            })}
            onOpenSession={() => {}}
        />,
    );
    assert.equal(screen.queryByRole("button", { name: "work.delete" }) === null, true);
    view.rerender(
        <WorkPane
            client={client as never}
            overview={overview({ ...runningWork, status: "completed", attemptId: "a" })}
            onOpenSession={() => {}}
        />,
    );
    const button = screen.getByRole("button", { name: "work.delete" }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    fireEvent.click(button);
    assert.equal(client.workDelete.mock.calls.length, 0);
});

it("safely renders an unknown status without enabling actions", () => {
    render(
        <WorkPane
            client={actionClient() as never}
            overview={overview({
                ...runningWork,
                status: "future" as never,
                attemptId: "a",
                canCancel: true,
            })}
            onOpenSession={() => {}}
        />,
    );
    assert.ok(screen.getByText("work.status.unknown"));
    assert.equal(screen.queryByRole("button", { name: "work.cancel" }), null);
    assert.equal(screen.queryByRole("button", { name: "work.delete" }) === null, true);
});

it("keeps legacy terminal rows read-only until their daemon supplies attempt metadata", () => {
    render(
        <WorkPane
            client={actionClient() as never}
            overview={overview({ ...runningWork, status: "completed" })}
            onOpenSession={() => {}}
        />,
    );
    assert.equal(screen.queryByRole("button", { name: "work.delete" }) === null, true);
});

it("keeps cancellation available after a failed request and explains a stale attempt", async () => {
    const client = actionClient();
    client.workCancel.mockRejectedValueOnce(new Error("transport gone"));
    client.workCancel.mockResolvedValueOnce({ outcome: "attempt_mismatch", newlyRequested: false });
    const view = {
        ...overview({ ...runningWork, status: "waiting", attemptId: "a", canCancel: true }),
        refresh: vi.fn(),
    };
    render(<WorkPane client={client as never} overview={view} onOpenSession={() => {}} />);
    const cancel = screen.getByRole("button", { name: "work.cancel" }) as HTMLButtonElement;
    fireEvent.click(cancel);
    await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "work.actionFailed"));
    assert.equal(cancel.disabled, false);
    fireEvent.click(cancel);
    await waitFor(() =>
        assert.equal(screen.getByRole("alert").textContent, "work.actionOutcome.attempt_mismatch"),
    );
    assert.equal(view.refresh.mock.calls.length, 2);
    assert.equal(client.workCancel.mock.calls.length, 2);
});

it("updates method gating when the connection handshakes again", () => {
    const methods: string[] = [];
    let ready: (() => void) | undefined;
    const client = {
        ...actionClient(methods),
        onConnectionReady: (handler: () => void) => {
            ready = handler;
            return () => {
                ready = undefined;
            };
        },
    };
    const view = render(
        <WorkPane
            client={client as never}
            overview={overview({ ...runningWork, attemptId: "a", canCancel: true })}
            onOpenSession={() => {}}
        />,
    );
    const cancel = screen.getByRole("button", { name: "work.cancel" }) as HTMLButtonElement;
    assert.equal(cancel.disabled, true);
    methods.push("work.cancel");
    act(() => ready?.());
    assert.equal(cancel.disabled, false);
    methods.length = 0;
    act(() => ready?.());
    assert.equal(cancel.disabled, true);
    view.unmount();
    assert.equal(ready, undefined);
});

it("shows a deletion conflict and re-enables the action after refresh", async () => {
    const client = actionClient();
    client.workDelete.mockResolvedValueOnce({ outcome: "running" });
    const view = {
        ...overview({ ...runningWork, status: "completed", attemptId: "a" }),
        refresh: vi.fn(),
    };
    render(<WorkPane client={client as never} overview={view} onOpenSession={() => {}} />);
    const button = screen.getByRole("button", { name: "work.delete" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() =>
        assert.equal(screen.getByRole("alert").textContent, "work.actionOutcome.running"),
    );
    assert.equal(button.disabled, false);
    assert.equal(view.refresh.mock.calls.length, 1);
});
