/** Consolidated from 4 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { JsonlSessionMetadata } from "../../src/runtime/pi/types.ts";
import { CommandIdempotencyGate } from "../../src/server/commandIdempotency.ts";
import type { MethodCtx } from "../../src/server/methodRegistry.ts";
import {
    getRegisteredMethod,
    RpcHandlerError,
    registerAdhocMethod,
} from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";
import type { CommandOutcome } from "../../src/server/rpcResponse.ts";
import { SidecarServer } from "../../src/server/server.ts";

describe("methods.sessionCreate", () => {
    /**
     * Handler-level unit tests for session.create rollback (an `initialPrompt`
     * failure removes only a transcript with no persisted message) and setModel /
     * setThinkingLevel error normalization.
     *
     * Uses a stub workspace to simulate attach/prompt/detach success/failure paths
     * without running a real harness — handler touches only detach / attach /
     * repo.delete / invalidateListCache / getAttached.
     */

    interface AttachedLike {
        prompt(text: string, images?: unknown): Promise<{ role: string; text: string }>;
    }

    interface WorkspaceStub {
        cwd: WorkspaceId;
        calls: string[];
        attached: Map<SessionId, AttachedLike>;
        meta: JsonlSessionMetadata;
        getAttached(id: SessionId): AttachedLike | undefined;
        attach(id: SessionId): Promise<AttachedLike>;
        detach(id: SessionId): Promise<void>;
        repo: {
            create(opts: { id: SessionId; cwd: WorkspaceId }): Promise<{
                metadata: JsonlSessionMetadata;
                close(): Promise<void>;
            }>;
            delete(meta: JsonlSessionMetadata): Promise<void>;
        };
        invalidateListCache(): void;
        setSessionModel(id: SessionId, provider: string, modelId: string): Promise<void>;
        setSessionThinkingLevel(id: SessionId, level: string): Promise<void>;
        setPlaceholderTitle(id: SessionId, name: string): Promise<boolean>;
        /** Last persisted message time; `undefined` models a transcript with no messages. */
        getSessionActivityAt(id: SessionId): Promise<number | undefined>;
        /** Stub already resolved its default model. */
        defaultModel?: unknown;
    }

    function makeStub(): WorkspaceStub {
        const calls: string[] = [];
        const attached = new Map<SessionId, AttachedLike>();
        const meta: JsonlSessionMetadata = {
            id: "sess-1",
            createdAt: Date.UTC(2026, 0, 1),
            modifiedAt: Date.UTC(2026, 0, 1),
            storageVersion: 1,
            cwd: "/tmp/test-ws",
            path: "/tmp/test-ws/.pi/agent/sessions/sess-1.jsonl",
        };
        return {
            cwd: asWorkspaceId("/tmp/test-ws"),
            calls,
            attached,
            meta,
            getAttached(id) {
                calls.push(`getAttached(${id})`);
                return attached.get(id);
            },
            async attach(id) {
                calls.push(`attach(${id})`);
                // Injected failure: stubAttached.fail = true / false
                const flags = attached as unknown as {
                    _failAttach?: boolean;
                    _failPrompt?: boolean;
                };
                const stubAttached: AttachedLike = flags._failAttach
                    ? {
                          async prompt() {
                              throw new Error("attach-throw");
                          },
                      }
                    : {
                          async prompt(text: string) {
                              calls.push(`prompt(${text})`);
                              // Distinguish prompt-success / prompt-failure
                              if (flags._failPrompt) {
                                  throw new Error("boom");
                              }
                              return { role: "assistant", text: `reply to ${text}` };
                          },
                      };
                attached.set(id, stubAttached);
                return stubAttached;
            },
            async detach(id) {
                calls.push(`detach(${id})`);
                attached.delete(id);
            },
            repo: {
                async create(opts) {
                    calls.push(`repo.create(${opts.id})`);
                    // pi 0.85 returns an *open* session with metadata as a plain
                    // property. The handler must close it before attaching, so the
                    // stub records that call — a missed close is what makes the
                    // real repo reject the subsequent open.
                    return {
                        metadata: meta,
                        close: async () => {
                            calls.push(`session.close(${opts.id})`);
                        },
                    };
                },
                async delete(m) {
                    calls.push(`repo.delete(${m.id})`);
                },
            },
            invalidateListCache() {
                calls.push("invalidateListCache");
            },
            async setSessionModel(id, provider, modelId) {
                calls.push(`setSessionModel(${id},${provider},${modelId})`);
            },
            async setSessionThinkingLevel(id, level) {
                calls.push(`setSessionThinkingLevel(${id},${level})`);
            },
            async setPlaceholderTitle(id, name) {
                calls.push(`setPlaceholderTitle(${id},${name})`);
                return true;
            },
            async getSessionActivityAt(id) {
                calls.push(`getSessionActivityAt(${id})`);
                const flags = attached as unknown as {
                    _activityAt?: number;
                    _failActivityProbe?: boolean;
                };
                if (flags._failActivityProbe) throw new Error("probe-boom");
                return flags._activityAt;
            },
            // Placeholder so session.create's defaultModel guard passes.
            defaultModel: { id: "stub-model" },
        };
    }

    function makeCtx(stub: WorkspaceStub, _method: string, params: unknown): MethodCtx<unknown> {
        return {
            id: "test-id",
            workspace: stub as unknown as MethodCtx<unknown>["workspace"],
            cwd: stub.cwd,
            // server field not used in the tested handler.
            server: {} as MethodCtx<unknown>["server"],
            params,
        };
    }

    before(() => {
        registerBuiltinMethods();
    });

    type StubFlags = {
        _failAttach?: boolean;
        _failPrompt?: boolean;
        _activityAt?: number;
        _failActivityProbe?: boolean;
    };

    function flagsOf(stub: WorkspaceStub): StubFlags {
        return stub.attached as unknown as StubFlags;
    }

    async function createWithInitialPrompt(stub: WorkspaceStub, expectedMessage: string) {
        const handler = getRegisteredMethod("session.create");
        assert.ok(handler, "session.create should be registered");
        const before = stub.calls.length;
        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(stub, "session.create", {
                        sessionId: "sess-1",
                        cwd: "/tmp/test-ws",
                        initialPrompt: "hello",
                    }),
                ),
            (e: unknown) => e instanceof Error && e.message === expectedMessage,
        );
        return stub.calls.slice(before);
    }

    describe("session.create rollback", () => {
        it("removes the transcript when the turn failed before any message was persisted", async () => {
            const stub = makeStub();
            flagsOf(stub)._failAttach = true;
            const tail = await createWithInitialPrompt(stub, "attach-throw");
            assert.ok(tail.includes("detach(sess-1)"), "detach should be called (idempotent)");
            assert.ok(tail.includes("repo.delete(sess-1)"), "empty orphan jsonl should be deleted");
            // The probe must read disk, not a cache that predates the failed turn.
            const iDetach = tail.indexOf("detach(sess-1)");
            // The handler also invalidates once right after repo.create; only the
            // call that follows the detach is the rollback's.
            const iFirstInv = tail.indexOf("invalidateListCache", iDetach);
            const iProbe = tail.indexOf("getSessionActivityAt(sess-1)");
            const iDelete = tail.indexOf("repo.delete(sess-1)");
            assert.ok(
                iDetach >= 0 && iFirstInv > iDetach && iProbe > iFirstInv,
                "probe order wrong",
            );
            assert.ok(iDelete > iProbe, "repo.delete must come after the emptiness probe");
            assert.ok(
                tail.lastIndexOf("invalidateListCache") > iDelete,
                "cache dropped after delete",
            );
        });

        it("keeps the transcript when the prompt failed after messages were persisted", async () => {
            const stub = makeStub();
            flagsOf(stub)._failPrompt = true;
            flagsOf(stub)._activityAt = Date.UTC(2026, 0, 1, 0, 5);
            const tail = await createWithInitialPrompt(stub, "boom");
            assert.ok(tail.indexOf("attach(sess-1)") < tail.indexOf("prompt(hello)"));
            assert.ok(tail.includes("detach(sess-1)"), "the failed run's handle is still released");
            assert.ok(
                !tail.includes("repo.delete(sess-1)"),
                `a conversation with persisted messages must survive, got: ${tail.join(", ")}`,
            );
        });

        it("keeps the transcript when the emptiness probe itself fails", async () => {
            const stub = makeStub();
            flagsOf(stub)._failPrompt = true;
            flagsOf(stub)._failActivityProbe = true;
            const tail = await createWithInitialPrompt(stub, "boom");
            assert.ok(
                !tail.includes("repo.delete(sess-1)"),
                "an unreadable transcript cannot be proven empty, so it is not deleted",
            );
        });

        it("never announces a deletion on failure (no session.deleted source)", async () => {
            const stub = makeStub();
            flagsOf(stub)._failPrompt = true;
            flagsOf(stub)._activityAt = Date.UTC(2026, 0, 1, 0, 5);
            const tail = await createWithInitialPrompt(stub, "boom");
            assert.ok(!tail.some((c) => c.includes("deleteSession")));
        });

        it("happy path: no rollback calls, returns assistantMessage", async () => {
            const stub = makeStub();
            const handler = getRegisteredMethod("session.create");
            assert.ok(handler);
            const before = stub.calls.length;
            const result = (await handler.handler(
                makeCtx(stub, "session.create", {
                    sessionId: "sess-1",
                    cwd: "/tmp/test-ws",
                    initialPrompt: "hi",
                }),
            )) as { sessionId: string; filePath: string; assistantMessage: { text: string } };
            const tail = stub.calls.slice(before);
            assert.equal(result.sessionId, "sess-1");
            assert.equal(result.filePath, stub.meta.path);
            assert.deepEqual(result.assistantMessage, { role: "assistant", text: "reply to hi" });
            assert.ok(!tail.includes("detach(sess-1)"), "no detach on success");
            assert.ok(!tail.includes("repo.delete(sess-1)"), "no repo.delete on success");
        });
    });

    describe("not-attached → invalid_state", () => {
        it("session.setModel throws invalid_state when not attached", async () => {
            const stub = makeStub();
            // getAttached returns undefined by default
            const handler = getRegisteredMethod("session.setModel");
            assert.ok(handler);
            await assert.rejects(
                () =>
                    handler.handler(
                        makeCtx(stub, "session.setModel", {
                            sessionId: "sess-1",
                            provider: "minimax",
                            modelId: "MiniMax-M2",
                        }),
                    ),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    e.code === "invalid_state" &&
                    /not attached/i.test(e.message),
            );
            // setSessionModel must not be called (only called when attached)
            assert.ok(
                !stub.calls.some((c) => c.startsWith("setSessionModel")),
                "setSessionModel must not be called when not attached",
            );
        });

        it("session.setThinkingLevel throws invalid_state when not attached", async () => {
            const stub = makeStub();
            const handler = getRegisteredMethod("session.setThinkingLevel");
            assert.ok(handler);
            await assert.rejects(
                () =>
                    handler.handler(
                        makeCtx(stub, "session.setThinkingLevel", {
                            sessionId: "sess-1",
                            level: "high",
                        }),
                    ),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    e.code === "invalid_state" &&
                    /not attached/i.test(e.message),
            );
            assert.ok(
                !stub.calls.some((c) => c.startsWith("setSessionThinkingLevel")),
                "setSessionThinkingLevel must not be called when not attached",
            );
        });
    });
});

describe("methods.sessionDelete", () => {
    /**
     * session.delete cascade: a session's subagent descendants and its
     * sidecar-owned auxiliary directory go with it.
     *
     * Stub workspace — the handler touches only listSessions / deleteSession /
     * agentSpawner.stopChildrenOf / sessionsRoot, so no harness is needed. The
     * directory removal is exercised against a real temp dir because `rm` is the
     * one side effect that cannot be observed through the call log.
     */

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

    function makeStub(
        sessionsRoot: string,
        parents: Record<string, string | undefined>,
    ): DeleteStub {
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
            const stub = makeStub(root, {
                parent: undefined,
                child: "parent",
                grandchild: "child",
            });

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
            const stub = makeStub(root, {
                parent: undefined,
                child: "parent",
                grandchild: "child",
            });

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
});

describe("methods.snapshot", () => {
    /**
     * Registry snapshot — asserts that registerBuiltinMethods() produces the
     * full set of known methods with the expected metadata. Pure file moves
     * MUST NOT change this; intentional metadata changes (add, remove, rename,
     * alter ensureWorkspace / command / turnStart) MUST update this explicitly.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/methods.snapshot.test.ts
     */

    interface MethodMeta {
        ensureWorkspace: boolean;
        command?: boolean;
        turnStart?: boolean;
        workspaceParam?: "workspace" | "cwd";
    }

    function snapshotMethod(name: string): MethodMeta | null {
        const reg = getRegisteredMethod(name);
        if (!reg) return null;
        return {
            ensureWorkspace: reg.ensureWorkspace,
            command: reg.options.command ?? undefined,
            turnStart: reg.options.turnStart ?? undefined,
            workspaceParam: reg.options.workspaceParam ?? undefined,
        };
    }

    const EXPECTED_METHODS: Record<string, MethodMeta> = {
        "agents.content": { ensureWorkspace: true },
        "agents.delete": { ensureWorkspace: true },
        "agents.list": { ensureWorkspace: true },
        "agents.write": { ensureWorkspace: true },
        "channels.bind": { ensureWorkspace: false, command: true },
        "channels.create": { ensureWorkspace: false, command: true },
        "channels.list": { ensureWorkspace: false },
        "channels.submitVerifyCode": { ensureWorkspace: false, command: true },
        "channels.unbind": { ensureWorkspace: false, command: true },
        "commandPermission.resolve": { ensureWorkspace: true, command: true },
        "extensions.status": { ensureWorkspace: false },
        "memory.deleteTopic": { ensureWorkspace: true },
        "memory.list": { ensureWorkspace: true },
        "memory.upsert": { ensureWorkspace: true },
        "memory.write": { ensureWorkspace: true },
        "provider.listModels": { ensureWorkspace: false },
        "providers.list": { ensureWorkspace: true },
        "session.abort": { ensureWorkspace: true, command: true },
        "session.attach": { ensureWorkspace: true, command: true },
        "session.cancelQueued": { ensureWorkspace: true, command: true },
        "session.compact": { ensureWorkspace: true, command: true },
        "session.contextInfo": { ensureWorkspace: true },
        "session.create": { ensureWorkspace: true, command: true },
        "session.delete": { ensureWorkspace: true, command: true },
        "session.detach": { ensureWorkspace: true, command: true },
        "session.events.get": { ensureWorkspace: true },
        "session.followUp": { ensureWorkspace: true, command: true },
        "session.history": { ensureWorkspace: true },
        "session.list": { ensureWorkspace: true },
        "session.listModels": { ensureWorkspace: true },
        "session.planState.get": { ensureWorkspace: true },
        "session.prompt": { ensureWorkspace: true, command: true, turnStart: true },
        "session.rename": { ensureWorkspace: true, command: true },
        "session.setModel": { ensureWorkspace: true, command: true },
        "session.setThinkingLevel": { ensureWorkspace: true, command: true },
        "session.snapshot.get": { ensureWorkspace: true },
        "session.steer": { ensureWorkspace: true, command: true },
        "session.submitAnswers": { ensureWorkspace: true, command: true, turnStart: true },
        "session.taskHistory.get": { ensureWorkspace: true },
        "session.tasks.get": { ensureWorkspace: true },
        "settings.get": { ensureWorkspace: false },
        "settings.write": { ensureWorkspace: false },
        "skills.content": { ensureWorkspace: true },
        "skills.list": { ensureWorkspace: true },
        "tools.list": { ensureWorkspace: true },
        "workspace.dispose": { ensureWorkspace: false, command: true, workspaceParam: "cwd" },
        "workspace.ensure": { ensureWorkspace: false, command: true, workspaceParam: "cwd" },
        "workspace.list": { ensureWorkspace: false },
    };

    before(() => {
        registerBuiltinMethods();
    });

    describe("registry snapshot", () => {
        for (const [name, expectedMeta] of Object.entries(EXPECTED_METHODS)) {
            it(`method ${name}: ensureWorkspace=${expectedMeta.ensureWorkspace}${expectedMeta.command ? ", command" : ""}${expectedMeta.turnStart ? ", turnStart" : ""}${expectedMeta.workspaceParam ? `, workspaceParam=${expectedMeta.workspaceParam}` : ""}`, () => {
                const actual = snapshotMethod(name);
                assert.ok(
                    actual !== null,
                    `expected ${name} to be registered but getRegisteredMethod returned undefined`,
                );
                // Compare only the keys the expected entry declares — handlers may
                // add new metadata fields over time, and the snapshot should stay
                // compact (only cares about the fields it asserts).
                const subset: Record<string, unknown> = {};
                for (const key of Object.keys(expectedMeta)) {
                    subset[key] = (actual as unknown as Record<string, unknown>)[key];
                }
                assert.deepEqual(subset, expectedMeta, `${name} metadata mismatch`);
            });
        }
    });
});

describe("commandIdempotency", () => {
    /** Monotonic clock — advance() fakes time passing without touching wall-clock. */
    class FakeClock {
        private t = 0;
        now = (): number => this.t;
        advance(ms: number): void {
            this.t += ms;
        }
    }

    let calls = 0;
    registerAdhocMethod(
        "test.command",
        false,
        async ({ params }) => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { value: (params as { value: string }).value };
        },
        { command: true },
    );

    let boundedCalls = 0;
    registerAdhocMethod(
        "test.bounded-command",
        false,
        async ({ params }) => {
            boundedCalls++;
            return { value: (params as { value: string }).value };
        },
        { command: true },
    );

    let inFlightBoundedCalls = 0;
    let inFlightGate: { release?: () => void; started?: () => void } | undefined;
    registerAdhocMethod(
        "test.in-flight-bounded-command",
        false,
        async () => {
            inFlightBoundedCalls++;
            inFlightGate?.started?.();
            await new Promise<void>((resolve) => {
                if (inFlightGate) {
                    // Chain releases so one release() unblocks every handler that
                    // ran under the same gate (a lazy-expired retry re-executes
                    // and stacks a second release on the same gate object).
                    const previous = inFlightGate.release;
                    inFlightGate.release = () => {
                        resolve();
                        previous?.();
                    };
                } else {
                    resolve();
                }
            });
            return { value: "in-flight" };
        },
        { command: true },
    );

    describe("command idempotency", () => {
        it("normalizes a non-positive record limit to one", async () => {
            const gate = new CommandIdempotencyGate({ limit: 0 });
            const exec = async (): Promise<CommandOutcome> => ({ ok: true, result: null });

            const first = gate.run("first", "fp", undefined, exec);
            assert.ok(first instanceof Promise);
            await first;

            const second = gate.run("second", "fp", undefined, exec);
            assert.ok(second instanceof Promise);
            await second;

            assert.equal(gate.size, 1);
        });

        it("executes concurrent retries with one commandId only once", async () => {
            calls = 0;
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            const first = server.dispatchRpc({
                id: "request-1",
                method: "test.command",
                commandId: "command-1",
                params: { value: "ok" },
            });
            const retry = server.dispatchRpc({
                id: "request-2",
                method: "test.command",
                commandId: "command-1",
                params: { value: "ok" },
            });

            assert.deepEqual(await first, { id: "request-1", ok: true, result: { value: "ok" } });
            assert.deepEqual(await retry, { id: "request-2", ok: true, result: { value: "ok" } });
            assert.equal(calls, 1);
        });

        it("rejects a reused commandId with a different payload", async () => {
            calls = 0;
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            await server.dispatchRpc({
                id: "request-1",
                method: "test.command",
                commandId: "command-1",
                params: { value: "first" },
            });

            const conflict = await server.dispatchRpc({
                id: "request-2",
                method: "test.command",
                commandId: "command-1",
                params: { value: "second" },
            });

            assert.deepEqual(conflict, {
                id: "request-2",
                ok: false,
                error: {
                    code: "command_id_conflict",
                    message: "commandId was already used with different request parameters",
                    data: undefined,
                },
            });
            assert.equal(calls, 1);
        });

        it("evicts the oldest settled command record when the limit is reached", async () => {
            boundedCalls = 0;
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                commandRecordLimit: 1,
            });

            await server.dispatchRpc({
                id: "first",
                method: "test.bounded-command",
                commandId: "first-command",
                params: { value: "first" },
            });
            await server.dispatchRpc({
                id: "second",
                method: "test.bounded-command",
                commandId: "second-command",
                params: { value: "second" },
            });
            await server.dispatchRpc({
                id: "first-retry",
                method: "test.bounded-command",
                commandId: "first-command",
                params: { value: "first" },
            });

            assert.equal(boundedCalls, 3);
        });

        it("does not evict an in-flight command record when pruning settled outcomes", async () => {
            inFlightBoundedCalls = 0;
            let started!: () => void;
            const inFlightStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const gate: { release?: () => void; started: () => void } = { started };
            inFlightGate = gate;
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                commandRecordLimit: 1,
            });

            const first = server.dispatchRpc({
                id: "in-flight-first",
                method: "test.in-flight-bounded-command",
                commandId: "in-flight-command",
                params: {},
            });
            await inFlightStarted;

            await server.dispatchRpc({
                id: "settled-second",
                method: "test.bounded-command",
                commandId: "settled-command",
                params: { value: "settled" },
            });
            const retry = server.dispatchRpc({
                id: "in-flight-retry",
                method: "test.in-flight-bounded-command",
                commandId: "in-flight-command",
                params: {},
            });

            assert.equal(inFlightBoundedCalls, 1);
            assert.ok(gate.release);
            gate.release();
            await Promise.all([first, retry]);
            inFlightGate = undefined;
        });

        it("expired in-flight record is reclaimed; same commandId re-executes", async () => {
            inFlightBoundedCalls = 0;
            let started!: () => void;
            const inFlightStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const gate: { release?: () => void; started: () => void } = { started };
            inFlightGate = gate;
            const clock = new FakeClock();
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                commandRecordTtlMs: 100,
                now: clock.now,
            });

            const first = server.dispatchRpc({
                id: "expired-first",
                method: "test.in-flight-bounded-command",
                commandId: "expired-command",
                params: {},
            });
            await inFlightStarted;
            assert.equal(inFlightBoundedCalls, 1);

            // Advance past the TTL while the handler is still gated: the record is
            // treated as absent, so a retry re-executes instead of replaying.
            clock.advance(101);
            const retry = server.dispatchRpc({
                id: "expired-retry",
                method: "test.in-flight-bounded-command",
                commandId: "expired-command",
                params: {},
            });

            assert.equal(inFlightBoundedCalls, 2);
            assert.ok(gate.release);
            gate.release();
            const [, retryResult] = await Promise.all([first, retry]);
            assert.equal(retryResult.ok, true);
            inFlightGate = undefined;
        });

        it("expired settled record does not count toward the limit", async () => {
            boundedCalls = 0;
            const clock = new FakeClock();
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                commandRecordLimit: 1,
                commandRecordTtlMs: 100,
                now: clock.now,
            });

            await server.dispatchRpc({
                id: "ttl-first",
                method: "test.bounded-command",
                commandId: "ttl-command",
                params: { value: "first" },
            });
            // Expire the settled record, then push a second command in — the limit
            // of 1 would otherwise evict it. The expired record is dropped eagerly.
            clock.advance(101);
            await server.dispatchRpc({
                id: "ttl-second",
                method: "test.bounded-command",
                commandId: "ttl-command-2",
                params: { value: "second" },
            });
            const retry = await server.dispatchRpc({
                id: "ttl-first-retry",
                method: "test.bounded-command",
                commandId: "ttl-command",
                params: { value: "first" },
            });

            assert.equal(retry.ok, true);
            assert.equal(boundedCalls, 3, "expired record must not survive to replay");
        });

        it("prune drops expired entries without a new RPC", async () => {
            const clock = new FakeClock();
            const gate = new CommandIdempotencyGate({ ttlMs: 100, limit: 100, now: clock.now });
            let calls = 0;
            const exec = async (): Promise<CommandOutcome> => {
                calls++;
                return { ok: true, result: { value: "sweep" } };
            };

            const first = gate.run(
                "test.bounded-command\u0000sweep-command",
                "fp",
                undefined,
                exec,
            );
            assert.ok(first instanceof Promise);
            assert.equal(gate.size, 1);
            await first;

            clock.advance(101);
            gate.prune();
            assert.equal(gate.size, 0, "expired entries must be swept even with no new RPC");

            // Behavior side: after the sweep the same key re-executes.
            const retry = gate.run(
                "test.bounded-command\u0000sweep-command",
                "fp",
                undefined,
                exec,
            );
            assert.ok(retry instanceof Promise);
            assert.equal(calls, 2, "expired record must not survive to replay");
            await retry;
        });
    });

    let turnCalls = 0;
    registerAdhocMethod(
        "test.turn",
        false,
        async () => {
            turnCalls++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { ok: true };
        },
        { command: true, turnStart: true },
    );

    it("rejects a second turn command for the same session while the first is active", async () => {
        turnCalls = 0;
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        const first = server.dispatchRpc({
            id: "turn-1",
            method: "test.turn",
            commandId: "turn-command-1",
            params: { workspace: "/workspace/a", sessionId: "session-1" },
        });
        const second = await server.dispatchRpc({
            id: "turn-2",
            method: "test.turn",
            commandId: "turn-command-2",
            params: { workspace: "/workspace/a", sessionId: "session-1" },
        });

        assert.deepEqual(second, {
            id: "turn-2",
            ok: false,
            error: {
                code: "session_busy",
                message: "a turn command is already active for this session",
                data: undefined,
            },
        });
        assert.deepEqual(await first, { id: "turn-1", ok: true, result: { ok: true } });
        assert.equal(turnCalls, 1);
    });
});
