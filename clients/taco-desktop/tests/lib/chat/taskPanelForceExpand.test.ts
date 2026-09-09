/**
 * consumeForceExpandFlag — TASK_PANEL_FORCE_EXPAND consumption contract.
 *
 * The flag is set by useWorkspaces on the first task snapshot for a sid.
 * App's useEffect re-reads it each render and delegates to this helper:
 * open the panel + dispatch CONSUMED so the flag clears. After CONSUMED,
 * the reducer stores false and subsequent TASKS_UPDATED for the same sid
 * do not re-set the flag (gate in useWorkspaces.ts is keyed off whether a
 * snapshot already exists for the sid).
 *
 * Run via `pnpm --filter @taco-ai/desktop test`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    type ConsumeForceExpandArgs,
    consumeForceExpandFlag,
} from "../../../src/lib/chat/taskPanelForceExpand";
import type { WorkspaceAction } from "../../../src/lib/chat/workspaceReducer";

function makeArgs(overrides: Partial<ConsumeForceExpandArgs> = {}): {
    args: ConsumeForceExpandArgs;
    calls: { show: number; dispatches: WorkspaceAction[] };
} {
    const dispatches: WorkspaceAction[] = [];
    let show = 0;
    const args: ConsumeForceExpandArgs = {
        forceExpandTaskPanel: false,
        activeCwd: null,
        showTaskPanel: () => {
            show += 1;
        },
        dispatchWs: (action) => {
            dispatches.push(action);
        },
        ...overrides,
    };
    return {
        args,
        calls: {
            get show() {
                return show;
            },
            dispatches,
        },
    };
}

describe("consumeForceExpandFlag", () => {
    it("opens the panel and dispatches CONSUMED when the flag is set", () => {
        const { args, calls } = makeArgs({
            forceExpandTaskPanel: true,
            activeCwd: "/ws",
        });
        consumeForceExpandFlag(args);
        assert.equal(calls.show, 1);
        assert.equal(calls.dispatches.length, 1);
        assert.deepEqual(calls.dispatches[0], {
            type: "TASK_PANEL_FORCE_EXPAND_CONSUMED",
            cwd: "/ws",
        });
    });

    it("is a no-op when the flag is false (subsequent TASKS_UPDATED for the same sid do not re-set it)", () => {
        const { args, calls } = makeArgs({
            forceExpandTaskPanel: false,
            activeCwd: "/ws",
        });
        consumeForceExpandFlag(args);
        assert.equal(calls.show, 0);
        assert.equal(calls.dispatches.length, 0);
    });

    it("is a no-op when there is no active cwd", () => {
        const { args, calls } = makeArgs({
            forceExpandTaskPanel: true,
            activeCwd: null,
        });
        consumeForceExpandFlag(args);
        assert.equal(calls.show, 0);
        assert.equal(calls.dispatches.length, 0);
    });

    it("does not re-open after the user manually closes mid-cycle", () => {
        // Simulates the user's scenario #2: panel was auto-opened once, CONSUMED
        // cleared the flag in the reducer; user then calls hideTaskPanel; a new
        // TASKS_UPDATED arrives but the gate in useWorkspaces (snapshot already
        // exists for the sid) keeps the flag false, so this helper bails.
        const { args, calls } = makeArgs({
            forceExpandTaskPanel: true,
            activeCwd: "/ws",
        });
        consumeForceExpandFlag(args);
        assert.equal(calls.show, 1);

        // Same call shape but the reducer has cleared the flag in between.
        const second = makeArgs({
            forceExpandTaskPanel: false,
            activeCwd: "/ws",
        });
        consumeForceExpandFlag(second.args);
        assert.equal(second.calls.show, 0);
        assert.equal(second.calls.dispatches.length, 0);
    });
});
