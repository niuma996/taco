import * as path from "node:path";
import { FILE_ACCESS_TOOL_NAMES } from "../tools/fileAccess.ts";

/** IM workspace disabled fs/proc tool names. Split into two groups so
 *  ImWorkspacePolicy can independently control file tools vs. shell.
 *
 *  The file group is every built-in that reads or writes files (see
 *  `tools/fileAccess.ts`), so a new file tool is denied without being listed
 *  here. */
export const IM_FS_TOOL_NAMES: readonly string[] = FILE_ACCESS_TOOL_NAMES;
export const IM_SHELL_TOOL_NAME = "shell";
export function makeImSessionsRoot(tacoHome: string, channelId: string): string {
    return path.join(tacoHome, "sessions", "im", channelId);
}
