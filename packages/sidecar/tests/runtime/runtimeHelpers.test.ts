/**
 * Small runtime helpers: the deferred-tool registry, IM tool filtering, and the
 * lane message queue.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentTool } from "@taco-ai/pi-harness";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import {
    DefaultDeferredToolRegistry,
    type DeferredToolRegistryOptions,
    type ToolCandidate,
} from "../../src/runtime/harness/deferredToolRegistry.ts";
import { cancelLaneQueued, enqueueLaneMessage } from "../../src/runtime/harness/laneQueue.ts";
import type { AgentLane } from "../../src/runtime/pi/types.ts";
import { filterToolsForImPolicy } from "../../src/runtime/toolAssembly.ts";
import type { TacoTool } from "../../src/tools/index.ts";

describe("deferredToolRegistry", () => {
    const fakeTool = (name: string): TacoTool =>
        ({
            name,
            label: name,
            description: `summary:${name}`,
            parameters: {},
            async execute() {
                return { content: [{ type: "text", text: "ok" }], details: {} };
            },
        }) as unknown as TacoTool;

    function candidate(
        name: string,
        opts: Partial<Omit<ToolCandidate, "name" | "load">> = {},
    ): ToolCandidate {
        return {
            name,
            summary: `summary:${name}`,
            loading: "deferred",
            source: "builtin",
            load: async () => fakeTool(name),
            ...opts,
        };
    }

    function makeRegistry(candidates: ToolCandidate[]): DefaultDeferredToolRegistry {
        return new DefaultDeferredToolRegistry({
            candidates,
        } satisfies DeferredToolRegistryOptions);
    }

    describe("DeferredToolRegistry", () => {
        it("listDeferred / listAlways filter by loading mode", () => {
            const registry = makeRegistry([
                candidate("git-status", { loading: "deferred" }),
                candidate("pg-query", { loading: "always" }),
            ]);
            assert.deepEqual(
                registry.listDeferred().map((c) => c.name),
                ["git-status"],
            );
            assert.deepEqual(
                registry.listAlways().map((c) => c.name),
                ["pg-query"],
            );
            assert.deepEqual(
                registry.listCandidates().map((c) => c.name),
                ["git-status", "pg-query"],
            );
        });

        it("listCandidates preserves registration order", () => {
            const registry = makeRegistry([candidate("b"), candidate("a"), candidate("c")]);
            assert.deepEqual(
                registry.listCandidates().map((c) => c.name),
                ["b", "a", "c"],
            );
        });

        it("load returns the tool for a known name", async () => {
            const registry = makeRegistry([candidate("git-status")]);
            const tool = await registry.load("git-status");
            assert.equal(tool?.name, "git-status");
        });

        it("load returns undefined for an unknown name", async () => {
            const registry = makeRegistry([candidate("git-status")]);
            assert.equal(await registry.load("nope"), undefined);
        });

        it("constructing with duplicate names throws", () => {
            assert.throws(
                () => makeRegistry([candidate("dup"), candidate("dup")]),
                /duplicate dynamic tool candidate name: dup/,
            );
        });

        it("load propagates factory errors", async () => {
            const registry = makeRegistry([
                {
                    name: "boom",
                    summary: "explodes",
                    loading: "deferred",
                    source: "builtin",
                    load: async () => {
                        throw new Error("load failed");
                    },
                },
            ]);
            await assert.rejects(() => registry.load("boom"), /load failed/);
        });
    });
});

describe("imToolFilter", () => {
    const DEFAULT_POLICY: ImWorkspacePolicy = {
        tools: { fsTools: "deny", shell: "deny" },
        commands: { mode: "ask" },
        executionDir: { mode: "shared" },
    };

    /** Fake tools covering both the fs/process group and unrelated tools. */
    function makeTools(withShellExtension: boolean): TacoTool[] {
        const names = [
            "read",
            "write",
            "edit",
            "grep",
            "glob",
            "shell",
            "agent",
            "skill",
            "todo_write",
            "memory",
            "ask_user",
        ];
        const tools = names.map(
            (name): TacoTool =>
                ({ name, execute: async () => ({ text: "" }) }) as unknown as TacoTool,
        );
        if (withShellExtension) {
            // An extension re-registering a same-named shell tool.
            tools.push({
                name: "shell",
                execute: async () => ({ text: "ext" }),
            } as unknown as TacoTool);
        }
        return tools;
    }

    function names(tools: TacoTool[]): string[] {
        return tools.map((t) => t.name);
    }

    describe("filterToolsForImPolicy", () => {
        it("default policy removes the six fs/process tools including an extension-supplied shell", () => {
            const out = filterToolsForImPolicy(makeTools(true), DEFAULT_POLICY);
            const n = names(out);
            for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
                assert.ok(!n.includes(tool), `expected ${tool} removed`);
            }
            for (const tool of ["agent", "skill", "todo_write", "memory", "ask_user"]) {
                assert.ok(n.includes(tool), `expected ${tool} kept`);
            }
        });

        it("shell allow keeps shell but still removes the five fs tools", () => {
            const policy: ImWorkspacePolicy = {
                tools: { fsTools: "deny", shell: "allow" },
                commands: { mode: "ask" },
                executionDir: { mode: "shared" },
            };
            const out = filterToolsForImPolicy(makeTools(true), policy);
            const n = names(out);
            assert.ok(n.includes("shell"));
            for (const tool of ["read", "write", "edit", "grep", "glob"]) {
                assert.ok(!n.includes(tool), `expected ${tool} removed`);
            }
        });

        it("fsTools allow keeps the five fs tools but still removes shell", () => {
            const policy: ImWorkspacePolicy = {
                tools: { fsTools: "allow", shell: "deny" },
                commands: { mode: "ask" },
                executionDir: { mode: "shared" },
            };
            const out = filterToolsForImPolicy(makeTools(false), policy);
            const n = names(out);
            for (const tool of ["read", "write", "edit", "grep", "glob"]) {
                assert.ok(n.includes(tool), `expected ${tool} kept`);
            }
            assert.ok(!n.includes("shell"), "expected shell removed");
        });

        it("both allow keeps everything", () => {
            const policy: ImWorkspacePolicy = {
                tools: { fsTools: "allow", shell: "allow" },
                commands: { mode: "ask" },
                executionDir: { mode: "shared" },
            };
            const out = filterToolsForImPolicy(makeTools(false), policy);
            assert.equal(out.length, makeTools(false).length);
        });

        it("does not mutate the input array when nothing is dropped", () => {
            const input = makeTools(false);
            const policy: ImWorkspacePolicy = {
                tools: { fsTools: "allow", shell: "allow" },
                commands: { mode: "ask" },
                executionDir: { mode: "shared" },
            };
            const out = filterToolsForImPolicy(input, policy);
            assert.equal(out, input); // same reference — no copy when nothing dropped
        });
    });

    // Kept import as a type-only reference so the AgentTool type is exercised
    // without pulling an unused import into the assertion helpers above.
    type _Unused = AgentTool;
});

describe("laneQueue", () => {
    type OperationKind = "run" | "compaction" | "navigation";

    interface RecordedEnqueue {
        method: "steer" | "followUp";
        text: string;
    }

    function makeLane(
        currentKind: OperationKind | null,
        opts: { entryId?: string; failWith?: unknown } = {},
    ): { lane: AgentLane; calls: RecordedEnqueue[] } {
        const calls: RecordedEnqueue[] = [];
        const write = async (method: "steer" | "followUp", text: string) => {
            calls.push({ method, text });
            if (opts.failWith !== undefined) return { ok: false as const, error: opts.failWith };
            return { ok: true as const, value: { entryId: opts.entryId ?? "entry-1" } };
        };
        const lane = {
            inspectExecution: async () => ({
                current: currentKind === null ? null : { id: "op-1", kind: currentKind },
            }),
            steer: (text: string) => write("steer", text),
            followUp: (text: string) => write("followUp", text),
        } as unknown as AgentLane;
        return { lane, calls };
    }

    describe("enqueueLaneMessage — only an active run consumes the queues", () => {
        it("run in flight → queued on the requested queue, echoing pi's entryId", async () => {
            for (const kind of ["steer", "followUp"] as const) {
                const { lane, calls } = makeLane("run", { entryId: "entry-42" });
                const result = await enqueueLaneMessage(lane, kind, "hello");
                assert.deepEqual(result, { mode: "queued", entryId: "entry-42" });
                assert.deepEqual(calls, [{ method: kind, text: "hello" }]);
            }
        });

        it("compaction in flight → idle, and nothing is written to the inbox", async () => {
            const { lane, calls } = makeLane("compaction");
            const result = await enqueueLaneMessage(lane, "steer", "hello");
            assert.deepEqual(result, { mode: "idle" });
            // The whole point: a compaction does not drain the steer queue, so
            // writing here would strand the message until the next prompt.
            assert.deepEqual(calls, []);
        });

        it("navigation in flight → idle (also does not drain the queues)", async () => {
            const { lane, calls } = makeLane("navigation");
            assert.deepEqual(await enqueueLaneMessage(lane, "steer", "hi"), { mode: "idle" });
            assert.deepEqual(calls, []);
        });

        it("lane idle → idle, so the caller can fall back to prompt", async () => {
            const { lane, calls } = makeLane(null);
            assert.deepEqual(await enqueueLaneMessage(lane, "followUp", "hi"), { mode: "idle" });
            assert.deepEqual(calls, []);
        });

        it("a rejected write surfaces as a throw, not a silent idle", async () => {
            const { lane } = makeLane("run", { failWith: new Error("lane closed") });
            await assert.rejects(() => enqueueLaneMessage(lane, "steer", "hello"));
        });
    });

    describe("cancelLaneQueued", () => {
        for (const kind of ["cancelled", "already_consumed", "not_found"] as const) {
            it(`passes through "${kind}" as a normal outcome`, async () => {
                const lane = {
                    cancelQueued: async () => ({ ok: true as const, value: { kind } }),
                } as unknown as AgentLane;
                assert.equal(await cancelLaneQueued(lane, "entry-1"), kind);
            });
        }

        it("a rejected cancel surfaces as a throw", async () => {
            const lane = {
                cancelQueued: async () => ({ ok: false as const, error: new Error("closed") }),
            } as unknown as AgentLane;
            await assert.rejects(() => cancelLaneQueued(lane, "entry-1"));
        });
    });
});
