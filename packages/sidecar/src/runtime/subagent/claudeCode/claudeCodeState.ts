import type { ClaudeCodePermissionMode } from "../../../agents/types.ts";
import { harnessContext } from "../../../lib/harnessContext.ts";
import type { Session } from "../../pi/types.ts";
import { value } from "../../pi/values.ts";

export interface ClaudeCodeState {
    nativeSessionId: string;
    cwd: string;
    configDir?: string;
    tools?: readonly string[];
    permissionMode?: ClaudeCodePermissionMode;
}

const CLAUDE_CODE_STATE = value<ClaudeCodeState>("taco.claudeCode.session");

export async function readClaudeCodeState(session: Session): Promise<ClaudeCodeState | undefined> {
    return (await session.getValue(CLAUDE_CODE_STATE, harnessContext))?.value;
}

export async function writeClaudeCodeState(
    session: Session,
    state: ClaudeCodeState,
): Promise<void> {
    await session.setValue(CLAUDE_CODE_STATE, state, harnessContext);
}
