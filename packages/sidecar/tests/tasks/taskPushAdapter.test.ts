import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TaskPushAdapter } from "../../src/tasks/taskPushAdapter.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";

describe("TaskPushAdapter", () => {
    it("publishes tasks.updated push frame with active list", () => {
        const captured: Array<{
            method: string;
            workspace: string;
            session: string;
            params: unknown;
        }> = [];
        const adapter = new TaskPushAdapter((method, workspace, session, params) => {
            captured.push({ method, workspace, session, params });
        });

        const store: TaskStore = {
            currentListId: "default-test",
            lists: new Map([
                [
                    "default-test",
                    {
                        id: "default-test",
                        name: "Default Tasks",
                        tasks: [
                            {
                                id: "1",
                                content: "First",
                                status: "pending",
                                activeForm: "Working",
                                createdAt: "",
                                updatedAt: "",
                            },
                        ],
                        metadata: { nextTaskId: 2 },
                        createdAt: "",
                        updatedAt: "",
                    },
                ],
            ]),
        };
        adapter.publishTasksUpdated("ws1", "sess1", store);

        assert.equal(captured.length, 1);
        assert.equal(captured[0].method, "tasks.updated");
        // cwd via push frame's workspace field, not duplicated in params (single source of truth)
        assert.equal(captured[0].workspace, "ws1");
        assert.equal(captured[0].session, "sess1");
        const params = captured[0].params as {
            sessionId: string;
            active: unknown;
            history: unknown;
        };
        assert.equal(params.sessionId, "sess1");
        assert.ok(params.active !== null, "active should not be null when list has pending tasks");
        assert.equal("cwd" in params, false, "params should not carry cwd");
    });

    it("publishes null active when no active list", () => {
        const captured: Array<{ method: string; params: unknown }> = [];
        const adapter = new TaskPushAdapter((method, _cwd, _sid, params) => {
            captured.push({ method, params });
        });

        const store: TaskStore = {
            currentListId: null,
            lists: new Map(),
        };
        adapter.publishTasksUpdated("ws1", "sess1", store);

        assert.equal(captured.length, 1);
        const params = captured[0].params as { active: unknown };
        assert.equal(params.active, null);
    });

    it("routes cwd via push frame workspace, sessionId via params", () => {
        const captured: Array<{ workspace: string; session: string; params: unknown }> = [];
        const adapter = new TaskPushAdapter((_method, workspace, session, params) => {
            captured.push({ workspace, session, params });
        });

        const store: TaskStore = {
            currentListId: null,
            lists: new Map(),
        };
        adapter.publishTasksUpdated("ws-x", "sess-y", store);

        // Route split: workspace in frame, sessionId in params (each is the single source of truth).
        assert.equal(captured[0].workspace, "ws-x");
        const params = captured[0].params as { sessionId: string; active: unknown };
        assert.equal(params.sessionId, "sess-y");
        assert.equal(params.active, null);
    });
});
