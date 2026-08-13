/**
 * Resolve where an IM workspace's tools actually run (executionCwd), given
 * the workspace policy. The session storage cwd is NEVER changed by this —
 * JsonlSessionRepo partitions JSONL by it, so it is fixed per workspace.
 *
 * Priority: valid binding > perChatScratch > default channel scratch.
 * A binding that fails validation (missing dir, not a directory, unwritable)
 * falls back to the default scratch with a `warning` so the caller can log it.
 */

import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImRoute, ImWorkspacePolicy } from "../channels/imWorkspacePolicy.ts";
import { chatPolicyKey } from "../channels/imWorkspacePolicy.ts";

export interface ImExecutionCwdResult {
    executionCwd: string;
    /** True when the cwd is shared by every chat on the channel. */
    shared: boolean;
    /** Present when a configured binding was rejected and we fell back. */
    warning?: string;
}

function isValidWritableDir(dir: string): boolean {
    try {
        const real = realpathSync(dir);
        if (!statSync(real).isDirectory()) return false;
        accessSync(real, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export function resolveImExecutionCwd(input: {
    sessionsRoot: string;
    route: ImRoute;
    policy: ImWorkspacePolicy;
}): ImExecutionCwdResult {
    const { sessionsRoot, route, policy } = input;
    const defaultScratch = join(sessionsRoot, "scratch");
    mkdirSync(defaultScratch, { recursive: true });

    const binding = policy.binding?.executionCwd;
    if (binding) {
        if (isValidWritableDir(binding)) {
            return { executionCwd: binding, shared: false };
        }
        return {
            executionCwd: defaultScratch,
            shared: true,
            warning: `binding executionCwd ${binding} is not a writable directory, falling back to ${defaultScratch}`,
        };
    }

    if (policy.perChatScratch) {
        const perChat = join(sessionsRoot, "chats", chatPolicyKey(route), "scratch");
        mkdirSync(perChat, { recursive: true });
        return { executionCwd: perChat, shared: false };
    }

    return { executionCwd: defaultScratch, shared: true };
}
