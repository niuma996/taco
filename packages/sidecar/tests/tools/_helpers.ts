/**
 * Test helpers — fixed stubs (NoopTaskPushAdapter + "test-session") for the
 * task tool's TaskSnapshotPublisher + SessionId parameters in unit tests.
 */

import { NoopTaskPushAdapter } from "../../src/tasks/taskPushAdapter.ts";

export function testTaskPublisher(): NoopTaskPushAdapter {
    return new NoopTaskPushAdapter();
}

export const TEST_SESSION_ID = "test-session";
