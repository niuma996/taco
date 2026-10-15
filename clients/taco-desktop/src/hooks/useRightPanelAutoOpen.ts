/**
 * useRightPanelAutoOpen — pop the task or subagent panel open when the running
 * turn produces something new to watch, at most once per run.
 *
 * Arming is the whole design. Only a run observed *starting* in the session on
 * screen arms it, so attaching an old session (whose history, task list and
 * subagents all arrive asynchronously after the switch) never pops a panel.
 * The one exception is a session that did not exist a moment ago: "new chat"
 * leaves no active session, and the first send allocates one whose run is
 * already in flight by the time its id lands here.
 *
 * Once per run: a user who closes the panel is not interrupted again until the
 * next turn, and a parallel fan-out does not keep stealing the selection.
 */
import { useEffect, useRef } from "react";
import { type SubagentEntry, shouldAutoOpen, shouldAutoOpenTasks } from "../lib/chat/subagentList";

export interface RightPanelAutoOpenArgs {
    /** `cwd sid` of the session on screen; null while none is (new chat). */
    sessionKey: string | null;
    runInFlight: boolean;
    subagentEntries: readonly SubagentEntry[];
    /** Id of the session's active task list, or null when there is none. */
    activeTaskListId: string | null;
    showTasks: () => void;
    showSubagent: (subSessionId: string) => void;
}

function subagentIds(entries: readonly SubagentEntry[]): Set<string> {
    return new Set(entries.map((e) => e.subSessionId).filter((id): id is string => id !== null));
}

export function useRightPanelAutoOpen(args: RightPanelAutoOpenArgs): void {
    const { sessionKey, runInFlight, subagentEntries, activeTaskListId, showTasks, showSubagent } =
        args;

    const armedRef = useRef(false);
    const openedThisRunRef = useRef(false);
    const prevKeyRef = useRef(sessionKey);
    const prevRunningRef = useRef(runInFlight);
    const seenSubagentsRef = useRef(subagentIds(subagentEntries));
    const prevTaskListRef = useRef(activeTaskListId);

    useEffect(() => {
        if (prevKeyRef.current !== sessionKey) {
            // A null previous key is a session that was just created by a send.
            armedRef.current = prevKeyRef.current === null && sessionKey !== null && runInFlight;
            openedThisRunRef.current = false;
            prevKeyRef.current = sessionKey;
        } else if (runInFlight && !prevRunningRef.current) {
            armedRef.current = true;
            openedThisRunRef.current = false;
        }
        prevRunningRef.current = runInFlight;

        const seen = seenSubagentsRef.current;
        const prevTaskList = prevTaskListRef.current;
        // Always track, armed or not, so only what appears after arming counts.
        seenSubagentsRef.current = subagentIds(subagentEntries);
        prevTaskListRef.current = activeTaskListId;

        if (!armedRef.current || !runInFlight) return;
        const subagent = shouldAutoOpen(seen, subagentEntries, openedThisRunRef.current);
        if (subagent !== null) {
            openedThisRunRef.current = true;
            showSubagent(subagent);
            return;
        }
        if (!openedThisRunRef.current && shouldAutoOpenTasks(prevTaskList, activeTaskListId)) {
            openedThisRunRef.current = true;
            showTasks();
        }
    }, [sessionKey, runInFlight, subagentEntries, activeTaskListId, showTasks, showSubagent]);
}
