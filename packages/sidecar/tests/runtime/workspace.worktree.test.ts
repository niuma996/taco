import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("worktree runtime boundaries", () => {
    const home = useTempTacoHome("worktree-runtime");

    it("uses main config fallback while keeping environment identity stable", async () => {
        const main = join(home, "project");
        const worktree = join(main, "worktrees", "feature");
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(main, "CLAUDE.md"), "Main rules");
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId(worktree), worktree, worktree, main),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
        });
        try {
            assert.ok(runtime.parentInstructionsBlock.includes("Main rules"));
            assert.ok(runtime.systemPrompt.includes(`Project root: ${main}`));
            assert.ok(runtime.systemPrompt.includes("Git worktree: yes"));
            const environment = runtime.systemPrompt.match(
                /<environment>[\s\S]*?<\/environment>/,
            )?.[0];
            writeFileSync(join(main, "CLAUDE.md"), "Updated main rules");
            runtime.updateInstructionsConfig(undefined);
            assert.ok(runtime.parentInstructionsBlock.includes("Updated main rules"));
            runtime.reloadAgentsNow([]);
            assert.equal(
                runtime.systemPrompt.match(/<environment>[\s\S]*?<\/environment>/)?.[0],
                environment,
            );
        } finally {
            await runtime.dispose();
        }
    });

    it("hides project and worktree paths for IM workspaces with a separate execution directory", async () => {
        const storage = join(home, "im-storage");
        const execution = join(home, "im-execution");
        mkdirSync(execution, { recursive: true });
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId("im://mock/u/c"), storage, execution, home),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
        });
        try {
            const environment = runtime.systemPrompt.match(
                /<environment>[\s\S]*?<\/environment>/,
            )?.[0];
            assert.ok(environment);
            assert.ok(!environment.includes(home));
            assert.ok(!environment.includes("Project root"));
            assert.ok(!environment.includes("Git worktree"));
            assert.ok(
                !runtime.configSources.instructionDirs.some(
                    (entry) => entry.dir === home && entry.label === "project",
                ),
            );
        } finally {
            await runtime.dispose();
        }
    });

    it("filters grants overlapping main code, including ancestors and symlinks, on every use", async () => {
        const main = join(home, "main");
        const worktree = join(main, "worktrees", "topic");
        const outside = join(home, "outside");
        const alias = join(home, "main-link");
        for (const path of [worktree, outside, join(main, "src"), join(worktree, "child")])
            mkdirSync(path, { recursive: true });
        symlinkSync(main, alias, "dir");
        let roots = [
            main,
            home,
            join(main, "src"),
            alias,
            join(alias, "missing-child"),
            worktree,
            join(worktree, "child"),
            outside,
        ];
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId(worktree), worktree, worktree, main),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            resolveAssociatedRoots: () => roots,
        });
        try {
            assert.deepEqual(runtime.associatedRoots(), [
                worktree,
                join(worktree, "child"),
                outside,
            ]);
            assert.deepEqual(
                runtime.sessionRegistry.getAssociatedRoots?.(),
                runtime.associatedRoots(),
            );
            const commandContext = (
                runtime.permissionBroker as unknown as {
                    commandContext: () => { allowedRoots: string[] };
                }
            ).commandContext;
            assert.deepEqual(commandContext().allowedRoots, [
                worktree,
                ...runtime.associatedRoots(),
            ]);
            roots = [realpathSync(main)];
            assert.deepEqual(runtime.associatedRoots(), []);
            assert.deepEqual(commandContext().allowedRoots, [worktree]);
        } finally {
            await runtime.dispose();
        }
        const ordinary = new WorkspaceRuntime({
            cwd: asWorkspaceId(main),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            resolveAssociatedRoots: () => roots,
        });
        try {
            assert.deepEqual(ordinary.associatedRoots(), roots);
        } finally {
            await ordinary.dispose();
        }
    });
});
