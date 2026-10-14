/**
 * useRightPanelAutoOpen — the task / subagent panels open once per run for
 * something new, and never for what an attached session already had.
 */
import { strict as assert } from "node:assert";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";

import {
    type RightPanelAutoOpenArgs,
    useRightPanelAutoOpen,
} from "../../src/hooks/useRightPanelAutoOpen";
import type { SubagentEntry } from "../../src/lib/chat/subagentList";

afterEach(cleanup);

function running(subSessionId: string): SubagentEntry {
    return {
        firstToolCallId: `call-${subSessionId}`,
        subSessionId,
        agentType: "Explore",
        description: "",
        prompt: "",
        status: "running",
    } as SubagentEntry;
}

function setup(initial: Partial<RightPanelAutoOpenArgs> = {}) {
    const showTasks = vi.fn();
    const showSubagent = vi.fn();
    let props: RightPanelAutoOpenArgs = {
        sessionKey: "/ws s1",
        runInFlight: false,
        subagentEntries: [],
        activeTaskListId: null,
        showTasks,
        showSubagent,
        ...initial,
    };
    const view = renderHook((p: RightPanelAutoOpenArgs) => useRightPanelAutoOpen(p), {
        initialProps: props,
    });
    const update = (patch: Partial<RightPanelAutoOpenArgs>) => {
        props = { ...props, ...patch };
        view.rerender(props);
    };
    return { showTasks, showSubagent, update };
}

describe("useRightPanelAutoOpen", () => {
    it("opens the subagent panel for a subagent spawned during a run", () => {
        const { showSubagent, update } = setup();
        update({ runInFlight: true });
        update({ subagentEntries: [running("c1")] });
        assert.deepEqual(showSubagent.mock.calls, [["c1"]]);
    });

    it("opens the task panel when a task list becomes active during a run", () => {
        const { showTasks, update } = setup();
        update({ runInFlight: true });
        update({ activeTaskListId: "list-1" });
        assert.equal(showTasks.mock.calls.length, 1);
    });

    it("opens at most once per run, and re-arms on the next run", () => {
        const { showTasks, showSubagent, update } = setup();
        update({ runInFlight: true });
        update({ subagentEntries: [running("c1")] });
        update({ subagentEntries: [running("c1"), running("c2")], activeTaskListId: "list-1" });
        assert.equal(showSubagent.mock.calls.length, 1);
        assert.equal(showTasks.mock.calls.length, 0);

        update({ runInFlight: false });
        update({ runInFlight: true });
        update({ activeTaskListId: "list-2" });
        assert.equal(showTasks.mock.calls.length, 1);
    });

    it("does not open for what an attached session already had", () => {
        // Switching to a session that is mid-run: its subagents and task list
        // arrive after the switch, and none of them is new to the user.
        const { showTasks, showSubagent, update } = setup({ sessionKey: "/ws s1" });
        update({ sessionKey: "/ws s2", runInFlight: true });
        update({ subagentEntries: [running("old")], activeTaskListId: "old-list" });
        assert.equal(showSubagent.mock.calls.length, 0);
        assert.equal(showTasks.mock.calls.length, 0);
    });

    it("arms for the session a new chat's first send creates", () => {
        const { showSubagent, update } = setup({ sessionKey: "/ws s1" });
        update({ sessionKey: null });
        update({ sessionKey: "/ws s-new", runInFlight: true });
        update({ subagentEntries: [running("c1")] });
        assert.deepEqual(showSubagent.mock.calls, [["c1"]]);
    });

    it("leaves the UI alone while no run is in flight", () => {
        const { showTasks, showSubagent, update } = setup();
        update({ subagentEntries: [running("c1")], activeTaskListId: "list-1" });
        assert.equal(showSubagent.mock.calls.length, 0);
        assert.equal(showTasks.mock.calls.length, 0);
    });
});
