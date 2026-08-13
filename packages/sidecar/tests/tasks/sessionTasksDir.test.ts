import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sessionTasksDir } from "../../src/tasks/sessionTasksDir.ts";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { loadAllTaskLists, saveTaskListToDisk } from "../../src/tasks/taskPersistence.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";

describe("sessionTasksDir", () => {
    it("is scoped under the caller-supplied sessionsRoot", () => {
        const dir = sessionTasksDir("abc-123", "/var/taco/sessions");
        assert.match(dir, /\/var\/taco\/sessions\/abc-123\/tasks$/);
    });

    it("follows the same root JsonlSessionRepo uses (TACO_HOME-aware)", () => {
        // Regression: hardcoded homedir() ignored TACO_HOME, splitting session
        // data and task state onto different roots — attach would hydrate an
        // empty task list.
        const dir = sessionTasksDir("abc-123", "/srv/taco/sessions");
        assert.equal(dir, "/srv/taco/sessions/abc-123/tasks");
    });
});

describe("loadAllTaskLists", () => {
    it("loads every persisted list in the dir", async () => {
        const base = await mkdtemp(join(tmpdir(), "taco-tasks-"));
        try {
            const store = createTaskStore("/ws");
            const l1 = createTaskList(store, "l1", "A");
            addTask(store, "l1", { content: "x", status: "completed", activeForm: "x" });
            const l2 = createTaskList(store, "l2", "B");
            await saveTaskListToDisk(base, l1);
            await saveTaskListToDisk(base, l2);
            const loaded = await loadAllTaskLists(base);
            assert.equal(loaded.length, 2);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    it("returns [] for a missing dir", async () => {
        const loaded = await loadAllTaskLists(join(tmpdir(), "taco-does-not-exist-xyz"));
        assert.deepEqual(loaded, []);
    });
});
