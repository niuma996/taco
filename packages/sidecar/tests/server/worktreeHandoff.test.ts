import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createWorktreeHandoff } from "../../src/server/worktreeHandoff.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("worktree-handoff");

test("managed handoff preserves source identity, model and attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-handoff-test-"));
    const sourcePath = join(root, "storage-prefix-source.txt");
    await writeFile(sourcePath, "attachment contents");
    const events: string[] = [];
    let promptText = "";
    let promptImages: unknown;
    const targetPath = join(root, ".taco", "worktrees", "isolated");
    const sourceSession = {
        sessionKind: "main",
        getModel: async () => ({ provider: "test", id: "model" }),
        getThinkingLevel: () => "high",
        getUiLocale: () => "zh",
    };
    const targetSession = {
        modelSeesImages: async () => false,
        prompt: async (text: string, images: unknown) => {
            events.push("prompt");
            promptText = text;
            promptImages = images;
            return { role: "assistant" };
        },
    };
    const source = {
        scope: { kind: "local" },
        getAttached: (id: string) => (id === "source" ? sourceSession : undefined),
    } as unknown as WorkspaceRuntime;
    const target = {
        workspaceKey: targetPath,
        sessionsRoot: join(home, "sessions"),
        setPlaceholderTitle: async () => {},
        invalidateListCache: () => events.push("invalidate"),
        createSession: async () => events.push("session"),
        attach: async (_id: string, options: unknown) => {
            events.push(`attach:${JSON.stringify(options)}`);
            return targetSession;
        },
    } as unknown as WorkspaceRuntime;
    try {
        const start = createWorktreeHandoff({
            ensureWorkspace: async (cwd) => (cwd === root ? source : target),
            create: async () => {
                events.push("create");
                return { path: targetPath, branch: "worktree/isolated" };
            },
            run: async (_cwd, operation) => operation(),
            emit: () => events.push("handoff"),
        });
        const result = await start({
            sourceWorkspace: asWorkspaceId(root),
            sourceSessionId: asSessionId("source"),
            name: "isolated",
            task: "inspect the attachment",
            images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
            attachments: [
                {
                    path: sourcePath,
                    name: "source.txt",
                    mimeType: "text/plain",
                    size: 19,
                    kind: "file",
                },
            ],
        });
        assert.equal(result.workspace, targetPath);
        assert.deepEqual(events.slice(0, 3), [
            "create",
            "session",
            `attach:${JSON.stringify({ model: { provider: "test", id: "model" }, thinkingLevel: "high" })}`,
        ]);
        assert.equal(events.at(-3), "handoff");
        assert.equal(events.at(-2), "prompt");
        assert.equal(events.at(-1), "invalidate");
        assert.match(promptText, /inspect the attachment/);
        assert.match(promptText, /<worktree_handoff>/);
        assert.match(promptText, /original request for isolation is satisfied/);
        assert.match(promptText, /name="source\.txt"/);
        assert.ok(!promptText.includes(sourcePath), "target tag must not reference source storage");
        assert.deepEqual(promptImages, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
        const match = promptText.match(/path="([^"]+)"/);
        assert.ok(match?.[1]);
        assert.equal(await readFile(match[1], "utf8"), "attachment contents");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("handoff refuses a subagent before creating a worktree", async () => {
    const source = {
        scope: { kind: "local" },
        getAttached: () => ({ sessionKind: "subagent" }),
    } as unknown as WorkspaceRuntime;
    const start = createWorktreeHandoff({
        ensureWorkspace: async () => source,
        create: async () => assert.fail("must not create"),
        run: async (_cwd, operation) => operation(),
        emit: () => assert.fail("must not emit"),
    });
    await assert.rejects(
        start({
            sourceWorkspace: asWorkspaceId("/project"),
            sourceSessionId: asSessionId("child"),
            name: "invalid",
            task: "task",
        }),
        /local main session/,
    );
});

test("target execution failure reports the retained worktree and session", async () => {
    const targetPath = "/project/.taco/worktrees/failed";
    const source = {
        scope: { kind: "local" },
        getAttached: () => ({
            sessionKind: "main",
            getModel: async () => undefined,
            getThinkingLevel: () => "off",
            getUiLocale: () => "en",
        }),
    } as unknown as WorkspaceRuntime;
    const target = {
        workspaceKey: targetPath,
        sessionsRoot: join(home, "sessions"),
        createSession: async () => {},
        setPlaceholderTitle: async () => {},
        invalidateListCache: () => {},
        attach: async () => ({
            modelSeesImages: async () => false,
            prompt: async () => {
                throw new Error("model unavailable");
            },
        }),
    } as unknown as WorkspaceRuntime;
    let emitted = false;
    const start = createWorktreeHandoff({
        ensureWorkspace: async (cwd) => (cwd === "/project" ? source : target),
        create: async () => ({ path: targetPath, branch: "worktree/failed" }),
        run: async (_cwd, operation) => operation(),
        emit: () => {
            emitted = true;
        },
    });
    await assert.rejects(
        start({
            sourceWorkspace: asWorkspaceId("/project"),
            sourceSessionId: asSessionId("source"),
            name: "failed",
            task: "task",
        }),
        (error: Error) => {
            assert.match(error.message, /retained .*failed.*session/);
            assert.match(error.message, /model unavailable/);
            return true;
        },
    );
    assert.equal(emitted, true);
});

test("cancellation before or during creation reports only resources actually created", async () => {
    const controller = new AbortController();
    let creates = 0;
    const start = createWorktreeHandoff({
        ensureWorkspace: async () =>
            ({
                scope: { kind: "local" },
                getAttached: () => ({ sessionKind: "main" }),
            }) as unknown as WorkspaceRuntime,
        create: async () => {
            creates++;
            controller.abort();
            return { path: "/repo/tree", branch: "worktree/one" };
        },
        run: async (_cwd, operation) => operation(),
        emit: () => assert.fail("cancelled"),
    });
    const request = {
        sourceWorkspace: asWorkspaceId("/repo"),
        sourceSessionId: asSessionId("source"),
        name: "one",
        task: "work",
        signal: controller.signal,
    };
    await assert.rejects(start(request), /retained \/repo\/tree: AbortError/);
    await assert.rejects(start(request), { name: "AbortError" });
    assert.equal(creates, 1);
});
