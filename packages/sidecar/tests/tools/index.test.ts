import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NoopPlanPushAdapter } from "../../src/plan/planPushAdapter.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";
import { defaultTools, defaultToolsWithTasks } from "../../src/tools/index.ts";
import { createPlanModeState } from "../../src/tools/planModeState.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

describe("defaultTools", () => {
    it("base defaultTools does NOT include task tools", () => {
        const tools = defaultTools();
        const names = tools.map((t) => t.name);
        assert.equal(names.includes("todoWrite"), false);
        assert.equal(names.includes("taskCreate"), false);
    });

    it("base defaultTools does NOT include plan tools", () => {
        const tools = defaultTools();
        const names = tools.map((t) => t.name);
        assert.equal(names.includes("planEnter"), false);
        assert.equal(names.includes("planExit"), false);
    });
});

describe("defaultToolsWithTasks", () => {
    it("includes all 4 task management tools and no taskGet", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);

        assert.ok(names.includes("todoWrite"));
        assert.ok(names.includes("taskCreate"));
        assert.ok(names.includes("taskUpdate"));
        assert.ok(names.includes("taskList"));
        assert.equal(names.includes("taskGet"), false);
    });

    it("includes both plan mode tools", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);

        assert.ok(names.includes("planEnter"));
        assert.ok(names.includes("planExit"));
    });

    it("still includes base tools", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);
        const hasShell = names.includes("shell");
        assert.ok(hasShell);
        assert.ok(names.includes("read"));
        assert.ok(names.includes("grep"));
    });
});
