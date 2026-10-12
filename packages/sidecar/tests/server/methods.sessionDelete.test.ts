/**
 * session.delete cascade: a session's subagent descendants and its
 * sidecar-owned auxiliary directory go with it.
 *
 * Stub workspace — the handler touches only listSessions / deleteSession /
 * agentSpawner.stopChildrenOf / sessionsRoot, so no harness is needed. The
 * directory removal is exercised against a real temp dir because `rm` is the
 * one side effect that cannot be observed through the call log.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import type { JsonlSessionMetadata } from "../../src/runtime/pi/types.ts";
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

interface DeleteStub {
    cwd: WorkspaceId;
    calls: string[];
    sessionsRoot: string;
    /** Sessions the spawner reports as still running after the wait. */
    stuck: Set<string>;
    listSessions(): Promise<JsonlSessionMetadata[]>;
    /** Stands in for the real one, which detaches, deletes and emits `session.deleted`. */
    deleteSession(id: SessionId): Promise<void>;
    agentSpawner: {
        stopChildrenOf(parent: SessionId, timeoutMs: number): Promise<SessionId[]>;
    };
}

function makeStub(sessionsRoot: string, parents: Record<string, string | undefined>): DeleteStub {
    const calls: string[] = [];
    const stuck = new Set<string>();
    const makeMeta = (id: string): JsonlSessionMetadata => {
        const parent = parents[id];
        return {
            id,
            createdAt: Date.UTC(2026, 0, 1),
            modifiedAt: Date.UTC(2026, 0, 1),
            storageVersion: 1,
            cwd: "/tmp/test-ws",
            path: `/tmp/test-ws/${id}.jsonl`,
            ...(parent === undefined ? {} : { parentSessionId: parent }),
        };
    };
    const stub: DeleteStub = {
        cwd: "/tmp/test-ws" as WorkspaceId,
        calls,
        sessionsRoot,
        stuck,
        listSessions: () => Promise.resolve(Object.keys(parents).map(makeMeta)),
        async deleteSession(id: SessionId) {
            // Mirrors pi: a session that is still open cannot be deleted.
            if (stuck.has(id)) throw new Error(`Session is open: ${id}`);
            calls.push(`deleteSession(${id})`);
        },
        agentSpawner: {
            async stopChildrenOf(parent: SessionId, _timeoutMs: number): Promise<SessionId[]> {
                calls.push(`stopChildrenOf(${parent})`);
                return Object.entries(parents)
                    .filter(([, p]) => p === parent)
                    .map(([id]) => id)
                    .filter((id) => stuck.has(id))
                    .map(asSessionId);
            },
        },
    };
    return stub;
}

function makeCtx(stub: DeleteStub, params: unknown): MethodCtx<unknown> {
    return {
        id: "test-id",
        workspace: stub as unknown as MethodCtx<unknown>["workspace"],
        cwd: stub.cwd,
        server: {} as MethodCtx<unknown>["server"],
        params,
    };
}

async function deleteWith(stub: DeleteStub, sessionId: string): Promise<void> {
    const handler = getRegisteredMethod("session.delete");
    assert.ok(handler, "session.delete should be registered");
    await handler.handler(makeCtx(stub, { sessionId }));
}

before(() => {
    registerBuiltinMethods();
});

describe("session.delete cascade", () => {
    it("deletes descendants before the parent", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const stub = makeStub(root, {
            parent: undefined,
            child: "parent",
            grandchild: "child",
        });

        await deleteWith(stub, "parent");

        const deleted = stub.calls.filter((c) => c.startsWith("deleteSession("));
        assert.deepEqual(
            deleted,
            ["deleteSession(grandchild)", "deleteSession(child)", "deleteSession(parent)"],
            "post-order: a child must never outlive its parent's deletion",
        );
    });

    it("aborts the whole tree, not just direct children", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const stub = makeStub(root, { parent: undefined, child: "parent", grandchild: "child" });

        await deleteWith(stub, "parent");

        const stopped = stub.calls.filter((c) => c.startsWith("stopChildrenOf("));
        // The grandchild is registered against `child`, so stopping only the
        // root's direct children would leave the innermost run going.
        assert.deepEqual(stopped, [
            "stopChildrenOf(grandchild)",
            "stopChildrenOf(child)",
            "stopChildrenOf(parent)",
        ]);
    });

    it("removes the sidecar-owned auxiliary directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const aux = join(root, "parent", "subagent-results");
        await mkdir(aux, { recursive: true });
        await writeFile(join(aux, "child.md"), "result", "utf8");
        const stub = makeStub(root, { parent: undefined });

        await deleteWith(stub, "parent");

        assert.deepEqual(
            await readdir(root),
            [],
            "<sessionsRoot>/<sid>/ holds tasks/ and subagent-results/, which repo.delete never reaches",
        );
    });

    it("removes every deleted descendant's auxiliary directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        // A subagent's tasks/ is keyed by its own id, not its parent's.
        for (const id of ["parent", "child", "grandchild"]) {
            await mkdir(join(root, id, "tasks"), { recursive: true });
        }
        const stub = makeStub(root, { parent: undefined, child: "parent", grandchild: "child" });

        await deleteWith(stub, "parent");

        assert.deepEqual(await readdir(root), []);
    });

    it("keeps a stuck child's auxiliary directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        await mkdir(join(root, "parent", "tasks"), { recursive: true });
        await mkdir(join(root, "child", "tasks"), { recursive: true });
        const stub = makeStub(root, { parent: undefined, child: "parent" });
        stub.stuck.add("child");

        await deleteWith(stub, "parent");

        // Its transcript survives, so its state must too.
        assert.deepEqual(await readdir(root), ["child"]);
    });

    it("skips a child that will not stop, and still deletes the parent", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const stub = makeStub(root, { parent: undefined, child: "parent" });
        stub.stuck.add("child");

        await deleteWith(stub, "parent");

        const deleted = stub.calls.filter((c) => c.startsWith("deleteSession("));
        // A subagent stuck on a long tool call must not make the whole session
        // undeletable; the leftover transcript is hidden from session.list.
        assert.deepEqual(deleted, ["deleteSession(parent)"]);
        assert.ok(
            !stub.calls.includes("deleteSession(child)"),
            "the stuck child must be skipped, not retried",
        );
    });

    it("leaves other sessions' directories alone", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const other = join(root, "sibling", "subagent-results");
        await mkdir(other, { recursive: true });
        const stub = makeStub(root, { parent: undefined, sibling: undefined });

        await deleteWith(stub, "parent");

        assert.deepEqual(await readdir(root), ["sibling"]);
    });

    // sessionDeleteSchema is Type.Any() and asSessionId only rejects "", so this
    // id is whatever a caller sent. The stub's deleteSession accepts any id, so
    // the containment check is exercised on its own rather than leaning on the
    // real one's session-list lookup.
    it("refuses a session id that escapes sessionsRoot", async () => {
        const root = await mkdtemp(join(tmpdir(), "taco-del-"));
        const outside = join(root, "..", `taco-del-outside-${process.pid}`);
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, "precious.txt"), "keep me", "utf8");
        try {
            const stub = makeStub(root, {});

            await assert.rejects(
                () => deleteWith(stub, `../${outside.split("/").pop()}`),
                /refusing to delete outside sessionsRoot/,
            );
            assert.deepEqual(stub.calls, [], "the id is rejected before any delete runs");

            assert.deepEqual(
                await readdir(outside),
                ["precious.txt"],
                "a traversal id must not reach the recursive delete",
            );
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});
