import { join } from "node:path";
import type { SessionId } from "@taco-ai/protocol";

/**
 * `<sessionsRoot>/<sid>/tasks` — task state must share `sessionsRoot` with
 * JsonlSessionRepo; a relative input lands tasks under the process cwd
 * (`loadAllTaskLists` does not resolve).
 */
export function sessionTasksDir(sessionId: SessionId, sessionsRoot: string): string {
    return join(sessionsRoot, sessionId, "tasks");
}
