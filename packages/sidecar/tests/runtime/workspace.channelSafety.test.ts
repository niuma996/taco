/**
 * IM/third-party channel path-privacy propagation.
 *
 * Regression guard: the workspace derives `isIm` once and must hand it to BOTH
 * the parent system prompt and the AgentSpawner, which rebuilds every subagent
 * prompt. A child that missed the flag would receive the default path-semantics
 * block (absolute-path example, "absolute paths are accepted") and no
 * `<channel_safety>` section, then relay full filesystem paths back through the
 * channel. The parent-only assertions passed while that gap was live, so these
 * tests deliberately reach into the spawner's inherited state.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildSystemPrompt } from "../../src/prompts/buildSystemPrompt.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

/** The flag the spawner inherits from the workspace and replays into child prompts. */
function inheritedHideWorkspacePath(ws: WorkspaceRuntime): boolean | undefined {
    return (ws.agentSpawner as unknown as { hideWorkspacePath: boolean | undefined })
        .hideWorkspacePath;
}

const ABSOLUTE_PATH_EXAMPLE = "/Users/me/project/src/foo.ts";

describe("IM workspace withholds the path from parent and children alike", () => {
    let sessionsRoot: string;
    let localCwd: string;
    let im: WorkspaceRuntime;
    let local: WorkspaceRuntime;

    before(() => {
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-chansafe-sessions-"));
        localCwd = mkdtempSync(join(tmpdir(), "taco-chansafe-local-"));
        im = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: "im://mock-1/u1/c1",
            workspaceKey: "im://mock-1/u1/c1",
            sessionsRoot,
        });
        local = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: localCwd,
            sessionsRoot,
        });
    });

    after(async () => {
        await im.dispose();
        await local.dispose();
        rmSync(sessionsRoot, { recursive: true, force: true });
        rmSync(localCwd, { recursive: true, force: true });
    });

    it("parent prompt on an IM workspace carries channel_safety and no absolute example", () => {
        assert.ok(im.systemPrompt.includes("<channel_safety>"));
        assert.ok(!im.systemPrompt.includes(ABSOLUTE_PATH_EXAMPLE));
    });

    it("spawner inherits hideWorkspacePath so rebuilt child prompts keep the guard", () => {
        const hideWorkspacePath = inheritedHideWorkspacePath(im);
        assert.equal(hideWorkspacePath, true, "child rebuild must see the IM flag");

        // Replay what agentSpawner does with the inherited flag.
        const child = buildSystemPrompt({
            tools: [{ name: "read" }],
            hideWorkspacePath,
            sessionKind: { role: "subagent", depth: 1 },
        });
        assert.ok(child.includes("<channel_safety>"), "child needs the channel_safety block");
        assert.ok(
            !child.includes(ABSOLUTE_PATH_EXAMPLE),
            "child must not see the absolute example",
        );
        assert.ok(child.includes("Never echo a full filesystem path back to the user"));
    });

    it("filesystem workspace keeps the default path semantics for parent and children", () => {
        assert.ok(!local.systemPrompt.includes("<channel_safety>"));
        assert.ok(local.systemPrompt.includes(ABSOLUTE_PATH_EXAMPLE));
        assert.ok(!inheritedHideWorkspacePath(local), "local workspace must not set the IM flag");
    });
});
