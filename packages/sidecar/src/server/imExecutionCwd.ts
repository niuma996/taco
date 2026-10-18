/**
 * Resolve where an IM workspace's tools actually run (executionCwd), given
 * the workspace policy. The session storage cwd is NEVER changed by this —
 * JsonlSessionRepo partitions JSONL by it, so it is fixed per workspace.
 *
 * The policy names one working directory per scope:
 * - `custom`: the configured absolute path, when it is a writable directory.
 * - `per-chat`: one directory per conversation.
 * - `shared`: one directory for the whole channel.
 *
 * A custom path that fails validation (missing dir, not a directory,
 * unwritable) falls back to the shared scratch with a `warning` so the caller
 * can log it.
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

    const dir = policy.executionDir;
    if (dir.mode === "custom" && dir.path) {
        if (isValidWritableDir(dir.path)) {
            return { executionCwd: dir.path, shared: false };
        }
        return {
            executionCwd: defaultScratch,
            shared: true,
            warning: `executionDir ${dir.path} is not a writable directory, falling back to ${defaultScratch}`,
        };
    }

    if (dir.mode === "per-chat") {
        const perChat = join(sessionsRoot, "chats", chatPolicyKey(route), "scratch");
        mkdirSync(perChat, { recursive: true });
        return { executionCwd: perChat, shared: false };
    }

    return { executionCwd: defaultScratch, shared: true };
}
