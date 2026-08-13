import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type PlanStateUpdatedParams, PushMethods, type TasksUpdatedParams } from "./index.js";

describe("TasksUpdatedParams shape", () => {
    it("carries active list and history meta", () => {
        const params: TasksUpdatedParams = {
            sessionId: "s1",
            active: {
                id: "list-1",
                name: "深圳骑行规划",
                tasks: [
                    { id: "task-1", content: "查天气", status: "completed", activeForm: "查天气" },
                    {
                        id: "task-2",
                        content: "设计路线",
                        status: "in_progress",
                        activeForm: "设计路线",
                    },
                ],
            },
            history: [{ id: "list-0", name: "上周", taskCount: 5, completedCount: 5 }],
        };
        assert.equal(params.active?.tasks.length, 2);
        assert.equal(params.history[0]?.completedCount, 5);
    });

    it("allows null active (no active list)", () => {
        const params: TasksUpdatedParams = { sessionId: "s1", active: null, history: [] };
        assert.equal(params.active, null);
    });
});

describe("plan.state.updated", () => {
    it("PushMethods.PlanStateUpdated is the wire method name", () => {
        assert.equal(PushMethods.PlanStateUpdated, "plan.state.updated");
    });

    it("PlanStateUpdatedParams carries active + currentSlug", () => {
        const on: PlanStateUpdatedParams = {
            sessionId: "s1",
            active: true,
            currentSlug: "2026-07-28-ab12cd",
        };
        const off: PlanStateUpdatedParams = { sessionId: "s1", active: false, currentSlug: null };
        assert.equal(on.active, true);
        assert.equal(off.currentSlug, null);
    });
});
