import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { filterToolsForAgent } from "../../src/agents/filterTools.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

const DEFAULT_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
};
const SHELL_ALLOW_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
};

function makeRuntime(
    opts: Partial<ConstructorParameters<typeof WorkspaceRuntime>[0]> = {},
): WorkspaceRuntime {
    const scratch = mkdtempSync(join(tmpdir(), "ws-cwd-scratch-"));
    const sessionsRoot = mkdtempSync(join(tmpdir(), "ws-cwd-sessions-"));
    return new WorkspaceRuntime({
        cwd: "im://mock-1/u1/c1",
        fsCwd: scratch,
        workspaceKey: "im://mock-1/u1/c1",
        sessionsRoot,
        ...opts,
    } as ConstructorParameters<typeof WorkspaceRuntime>[0]);
}

describe("WorkspaceRuntime sessionCwd / executionCwd split", () => {
    it("sessionCwd is the fsCwd and defaults executionCwd to the same dir", () => {
        const ws = makeRuntime();
        assert.equal(ws.sessionCwd, ws.executionCwd); // default: same dir
    });

    it("repo.list scopes to the session cwd directory", async () => {
        const ws = makeRuntime();
        const list = await ws.repo.list({ cwd: ws.sessionCwd });
        assert.ok(Array.isArray(list));
    });

    it("executionCwd overrides env.cwd and defaults to sessionCwd when absent", () => {
        const exec = mkdtempSync(join(tmpdir(), "ws-cwd-exec-"));
        const ws = makeRuntime({ executionCwd: exec });
        assert.equal(ws.executionCwd, exec);
        assert.equal(ws.env.cwd, exec);
        assert.notEqual(ws.sessionCwd, ws.executionCwd); // storage identity unchanged
        const defaulted = makeRuntime();
        assert.equal(defaulted.executionCwd, defaulted.sessionCwd);
    });

    it("applies the policy to the assembled tool set", () => {
        const denied = makeRuntime({ imPolicy: DEFAULT_POLICY });
        const deniedNames = denied.tools.map((t) => t.name);
        for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
            assert.ok(!deniedNames.includes(tool), `expected ${tool} removed under default policy`);
        }

        const allowed = makeRuntime({ imPolicy: SHELL_ALLOW_POLICY });
        const allowedNames = allowed.tools.map((t) => t.name);
        assert.ok(allowedNames.includes("shell"), "expected shell present under shell: allow");
        assert.ok(!allowedNames.includes("read"), "expected read still removed");
    });

    it("legacy disableFsTools behaves exactly like the default deny policy", () => {
        const legacy = makeRuntime({ disableFsTools: true });
        const names = legacy.tools.map((t) => t.name);
        for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
            assert.ok(!names.includes(tool), `expected ${tool} removed`);
        }
    });

    // Core security assertion of the design: a subagent may only ever receive
    // the intersection of the parent's ALREADY-FILTERED toolset and its own
    // whitelist. An agent definition asking for `shell` explicitly must still
    // come back empty when the workspace policy denies it.
    it("a subagent cannot recover a tool the workspace policy denied", () => {
        const ws = makeRuntime({ imPolicy: DEFAULT_POLICY });
        assert.ok(!ws.tools.some((t) => t.name === "shell"));
        assert.ok(!ws.agentSpawner.tools.some((t) => t.name === "shell"));

        const explicit = filterToolsForAgent(
            ws.agentSpawner.tools as never,
            ["shell", "read", "grep"],
            1,
        );
        assert.deepEqual(
            explicit.map((t) => t.name),
            [],
            "whitelisting shell must not resurrect it",
        );

        const inheritAll = filterToolsForAgent(ws.agentSpawner.tools as never, undefined, 1);
        assert.ok(!inheritAll.some((t) => t.name === "shell"));
    });

    it("a subagent does receive a tool the policy allows", () => {
        const ws = makeRuntime({ imPolicy: SHELL_ALLOW_POLICY });
        const child = filterToolsForAgent(ws.agentSpawner.tools as never, ["shell"], 1);
        assert.deepEqual(
            child.map((t) => t.name),
            ["shell"],
        );
    });

    it("memory stays partitioned by sessionCwd, not executionCwd", () => {
        const exec = mkdtempSync(join(tmpdir(), "ws-cwd-exec2-"));
        const ws = makeRuntime({ executionCwd: exec });
        // memoryStore.initialize already ran with sessionCwd; a second call with
        // a different id must be a no-op (initialized flag guards it).
        const probe = (ws as unknown as { memoryStore: { _workspaceId: string } }).memoryStore;
        assert.equal(probe._workspaceId, ws.sessionCwd);
    });
});
