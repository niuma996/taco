import * as path from "node:path";
import { getFileAccessToolNames } from "../tools/fileAccess.ts";

/** IM workspace disabled fs/proc tool names. Split into two groups so
 *  ImWorkspacePolicy can independently control file tools vs. shell.
 *
 *  The file group is every built-in or extension tool that reads or writes files (see
 *  `tools/fileAccess.ts`), so a new file tool is denied without being listed
 *  here. */
export function getImFsToolNames(): readonly string[] {
    return getFileAccessToolNames();
}
export const IM_SHELL_TOOL_NAME = "shell";
export function makeImSessionsRoot(tacoHome: string, channelId: string): string {
    return path.join(tacoHome, "sessions", "im", channelId);
}
