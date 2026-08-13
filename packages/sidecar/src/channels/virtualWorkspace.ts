import * as path from "node:path";

/** IM workspace disabled fs/proc tool names (must match the names registered by create*Tool, all lowercase).
 *  Split into two groups so ImWorkspacePolicy can independently control file tools vs. shell. */
export const IM_FS_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "grep", "glob"];
export const IM_SHELL_TOOL_NAME = "shell";
export function makeImSessionsRoot(tacoHome: string, channelId: string): string {
    return path.join(tacoHome, "sessions", "im", channelId);
}
