/**
 * TaskPushAdapter — translates task tool snapshot changes into named push
 * frames (tasks.updated) for the desktop TaskPanel.
 *
 * Mirrors CompactionPushAdapter: the adapter uses the injected EmitPushFn so
 * the server controls serialization and sessionKind routing (no circular
 * dependencies). Triggered by each task tool via TaskSnapshotPublisher.publishTasksUpdated.
 */

import type { SessionId, TasksUpdatedParams, WorkspaceId } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import { buildTasksGetResult } from "../server/handlers/sessionTasksGet.ts";
import type { EmitPushFn } from "../server/pushTypes.ts";
import type { TaskStore } from "./taskTypes.ts";

/** Publisher interface for task tools — TaskPushAdapter / Noop both implement it. */
export interface TaskSnapshotPublisher {
    publishTasksUpdated(cwd: WorkspaceId, sessionId: SessionId, store: TaskStore): void;
}

export class TaskPushAdapter implements TaskSnapshotPublisher {
    constructor(private readonly emitPush: EmitPushFn) {}

    publishTasksUpdated(cwd: WorkspaceId, sessionId: SessionId, store: TaskStore): void {
        const params: TasksUpdatedParams = {
            sessionId,
            ...buildTasksGetResult(store),
        };
        this.emitPush(PushMethods.TasksUpdated, cwd, sessionId, params);
    }
}

/** Silent variant — for envs without a push stream (unit tests, external hosts). */
export class NoopTaskPushAdapter implements TaskSnapshotPublisher {
    publishTasksUpdated(): void {
        /* no-op */
    }
}
