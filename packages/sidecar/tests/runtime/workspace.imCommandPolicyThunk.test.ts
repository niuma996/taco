/**
 * WorkspaceRuntime's PermissionBroker is wired with a `resolveImPolicy()`
 * thunk, not a constructor-time snapshot of `commands`.
 *
 * Before this fix the broker was constructed with
 * `imCommandPolicy: () => imPolicy?.commands`, where `imPolicy` is the local
 * const captured at line 472 — before `resolveImPolicy` was assigned on line
 * 480. Tool assembly, by contrast, already called `this.resolveImPolicy()`
 * directly, so the two paths disagreed: a hand-edited `commands` block
 * (`mode: ask -> auto`, an `allow` rule) took effect for the next turn's
 * tool list but never for command evaluation on a live IM workspace.
 *
 * The test reads the broker's `imCommandPolicy` thunk via reflection on the
 * WorkspaceRuntime's public `permissionBroker` field, then flips the policy
 * the workspace resolves to and asserts the broker's thunk returns the new
 * `commands` object on the very next call. This is the exact line content
 * that matters: any future engineer closing over `imPolicy` again would
 * fail this assertion.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

const ASK_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
};
const AUTO_ALLOW_LS_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "auto", allow: ["ls"] },
};

/** Pull the broker's private `imCommandPolicy` thunk out of a workspace. */
function getBrokerPolicyThunk(ws: WorkspaceRuntime): () => unknown {
    const broker = ws.permissionBroker as unknown as {
        imCommandPolicy?: () => unknown;
    };
    if (!broker.imCommandPolicy) {
        throw new Error(
            "broker has no imCommandPolicy thunk — fix removed or PermissionBroker shape changed",
        );
    }
    return broker.imCommandPolicy;
}

describe("WorkspaceRuntime PermissionBroker im-policy wiring", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "ws-im-policy-cwd-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "ws-im-policy-sessions-"));
    });

    afterEach(async () => {
        await ws?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    it("the broker's imCommandPolicy thunk reads the current resolveImPolicy(), not a snapshot", () => {
        let policy: ImWorkspacePolicy = ASK_POLICY;
        ws = new WorkspaceRuntime({
            cwd: "im://mock-2/u1/c1",
            fsCwd: cwd,
            workspaceKey: "im://mock-2/u1/c1",
            sessionsRoot,
            resolveImPolicy: () => policy,
        } as ConstructorParameters<typeof WorkspaceRuntime>[0]);

        const thunk = getBrokerPolicyThunk(ws);
        assert.deepEqual(thunk(), ASK_POLICY.commands);

        // The policy is edited in place — e.g. a hand-edited policy file or
        // an admin RPC write — with no reattach and no new WorkspaceRuntime.
        policy = AUTO_ALLOW_LS_POLICY;
        assert.deepEqual(
            thunk(),
            AUTO_ALLOW_LS_POLICY.commands,
            "broker must re-read resolveImPolicy() on every call, not capture it at construction",
        );
    });
});
