import type { CodexApprovalPolicy, CodexSandboxMode } from "../../../agents/types.ts";
import { harnessContext } from "../../../lib/harnessContext.ts";
import type { Session } from "../../pi/types.ts";
import { value } from "../../pi/values.ts";

/** Durable mapping from a Taco child session to its native Codex thread. */
export interface CodexState {
    nativeThreadId: string;
    cwd: string;
    profileIdentity: string;
    sdkVersion: string;
    threadOptions: {
        /** Absent = the user's own Codex configuration picks the model. */
        model?: string;
        sandbox?: CodexSandboxMode;
        approvalPolicy?: CodexApprovalPolicy;
        skipGitRepoCheck?: boolean;
        communicationTools?: readonly string[];
    };
}

const CODEX_STATE = value<CodexState>("taco.codex.session");

export async function readCodexState(session: Session): Promise<CodexState | undefined> {
    const raw = (await session.getValue(CODEX_STATE, harnessContext))?.value;
    if (!raw || typeof raw !== "object") return undefined;
    const state = raw as Partial<CodexState>;
    if (
        typeof state.nativeThreadId !== "string" ||
        state.nativeThreadId.trim() === "" ||
        typeof state.cwd !== "string" ||
        typeof state.profileIdentity !== "string" ||
        typeof state.sdkVersion !== "string" ||
        !state.threadOptions ||
        typeof state.threadOptions !== "object"
    ) {
        return undefined;
    }
    return state as CodexState;
}

export async function writeCodexState(session: Session, state: CodexState): Promise<void> {
    await session.setValue(CODEX_STATE, state, harnessContext);
}

/** Stable identity for the profile options that a native resume must not mutate. */
export function codexProfileIdentity(
    agentType: string,
    config:
        | {
              model?: string;
              sandbox?: CodexSandboxMode;
              approvalPolicy?: CodexApprovalPolicy;
          }
        | undefined,
    communicationTools?: readonly string[],
    rolePrompt?: string,
): string {
    return JSON.stringify({
        agentType,
        model: config?.model ?? null,
        sandbox: config?.sandbox ?? null,
        approvalPolicy: config?.approvalPolicy ?? null,
        communicationTools: [...(communicationTools ?? [])].sort(),
        rolePromptHash: rolePrompt ? createHash("sha256").update(rolePrompt).digest("hex") : null,
    });
}

import { createHash } from "node:crypto";
