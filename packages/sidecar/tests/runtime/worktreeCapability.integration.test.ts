import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("worktree-capability");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

test("each turn mounts and retires the tool and guidance from fresh Git facts", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "taco-worktree-capability-")));
    const runtime = new WorkspaceRuntime({
        cwd: asWorkspaceId(cwd),
        providerKeyStore: new ProviderKeyStore({}),
        sessionsRoot: join(home, "sessions"),
        tools: [],
        worktreeStart: async () => assert.fail("not invoked"),
    });
    const prepare = () =>
        (runtime as unknown as { prepareWorktreeTurn(): Promise<void> }).prepareWorktreeTurn();
    const refresh = () =>
        runtime.refreshToolset(asSessionId("main"), {
            taskStore: { currentListId: null, lists: new Map() },
            planState: { active: false, currentSlug: null },
            tasksDir: "",
        });
    try {
        await prepare();
        assert.equal(
            refresh().some((tool) => tool.name === "worktreeStart"),
            false,
        );
        assert.equal(runtime.systemPrompt.includes("<worktree_isolation>"), false);
        git(cwd, "init", "--initial-branch=main");
        await prepare();
        assert.equal(
            refresh().some((tool) => tool.name === "worktreeStart"),
            false,
            "unborn HEAD is not creatable",
        );
        git(
            cwd,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        await prepare();
        assert.equal(
            refresh().some((tool) => tool.name === "worktreeStart"),
            true,
        );
        assert.match(runtime.systemPrompt, /<worktree_isolation>/);
        await rm(join(cwd, ".git"), { recursive: true });
        await prepare();
        assert.equal(
            refresh().some((tool) => tool.name === "worktreeStart"),
            false,
        );
        assert.equal(runtime.systemPrompt.includes("<worktree_isolation>"), false);
    } finally {
        await runtime.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});
