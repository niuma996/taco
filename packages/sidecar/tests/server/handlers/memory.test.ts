/**
 * memory.* handlers — happy path and enabled=false path for list/write/deleteTopic;
 * writeMemory conflicts surface as RpcHandlerError("memory.conflict").
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/memory.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { hashOf, LocalMemoryStore, NoOpMemoryStore } from "../../../src/memory/index.ts";
import type { MemoryEntry } from "../../../src/memory/types.ts";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

before(() => {
    registerBuiltinMethods();
});

let tmpRoot: string;
let prevTacoHome: string | undefined;

beforeEach(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "taco-mem-handlers-"));
    process.env.TACO_HOME = tmpRoot;
});

afterEach(() => {
    if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
    else process.env.TACO_HOME = prevTacoHome;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const sampleTopic: MemoryEntry = {
    id: "user-role",
    name: "User uses pnpm",
    description: "Project uses pnpm",
    type: "user",
    content: "User said pnpm explicitly.",
    createdAt: "2026-07-29T00:00:00.000Z",
};

function makeCtx(workspace: Partial<WorkspaceRuntime>, params: unknown = {}) {
    return {
        id: "test-id",
        workspace: workspace as WorkspaceRuntime,
        cwd: "/tmp/ws",
        server: {},
        params,
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

describe("memory.list", () => {
    it("returns memoryContent + hash + topics + enabled=true for LocalMemoryStore", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        await store.appendEntry(sampleTopic);

        const handler = getRegisteredMethod("memory.list");
        assert.ok(handler);
        const result = (await handler.handler(makeCtx({ memoryStore: store }))) as {
            memoryContent: string;
            memoryHash: string;
            topics: { id: string }[];
            enabled: boolean;
        };

        assert.equal(result.enabled, true);
        assert.equal(result.memoryHash, hashOf(result.memoryContent));
        assert.equal(result.topics.length, 1);
        assert.equal(result.topics[0]?.id, "user-role");
    });

    it("returns enabled=false when store is NoOpMemoryStore", async () => {
        const store = new NoOpMemoryStore();
        store.initialize("ws-test");

        const handler = getRegisteredMethod("memory.list");
        assert.ok(handler);
        const result = (await handler.handler(makeCtx({ memoryStore: store }))) as {
            memoryContent: string;
            topics: unknown[];
            enabled: boolean;
        };

        assert.equal(result.enabled, false);
        assert.equal(result.memoryContent, "");
        assert.deepEqual(result.topics, []);
    });
});

describe("memory.write", () => {
    it("writes new content when baseHash matches", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const baseline = store.readMemory();
        const baseHash = hashOf(baseline);
        const newContent = `${baseline}\n## [2026-07-29T00:00:00.000Z] user\n\nmanual\n`;

        const handler = getRegisteredMethod("memory.write");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            { workspace: "/tmp/ws", content: newContent, baseHash },
        );
        const result = (await handler.handler(ctx)) as { ok: true };

        assert.deepEqual(result, { ok: true });
        assert.equal(store.readMemory(), newContent);
    });

    it("translates MemoryConflictError to RpcHandlerError memory.conflict with current data", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const baseline = store.readMemory();
        const staleHash = hashOf(baseline);

        // First write to advance the hash
        await store.writeMemory(`${baseline}\n## [...] first\n`, staleHash);
        const currentContent = store.readMemory();
        const currentHash = hashOf(currentContent);

        // Second write with a stale hash
        const handler = getRegisteredMethod("memory.write");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                content: `${baseline}\n## [...] second\n`,
                baseHash: staleHash,
            },
        );

        await assert.rejects(
            () => handler.handler(ctx),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "memory.conflict");
                const data = (err as { data?: unknown }).data as {
                    currentContent: string;
                    currentHash: string;
                };
                assert.equal(data.currentContent, currentContent);
                assert.equal(data.currentHash, currentHash);
                return true;
            },
        );
    });
});

describe("memory.upsert", () => {
    it("add creates a new topic and returns outcome=created", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);

        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "add",
                id: "new-topic",
                name: "New Topic",
                content: "body",
                type: "user",
            },
        );
        const result = (await handler.handler(ctx)) as {
            ok: true;
            outcome: "created" | "updated" | "deleted";
        };

        assert.deepEqual(result, { ok: true, outcome: "created" });
        assert.equal(store.getTopic("new-topic")?.content, "body");
    });

    it("add fails with id_conflict when id already exists", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        await store.appendEntry(sampleTopic);

        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "add",
                id: "user-role",
                name: "Dup",
                content: "dup body",
                type: "user",
            },
        );

        await assert.rejects(
            () => handler.handler(ctx),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "id_conflict");
                return true;
            },
        );
    });

    it("replace updates content and returns outcome=updated", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        await store.appendEntry(sampleTopic);

        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "replace",
                id: "user-role",
                content: "new body",
            },
        );
        const result = (await handler.handler(ctx)) as {
            ok: true;
            outcome: "created" | "updated" | "deleted";
        };
        assert.equal(result.outcome, "updated");
        assert.equal(store.getTopic("user-role")?.content, "new body");
    });

    it("replace writes updatedAt so listTopics wire response includes it", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        await store.appendEntry(sampleTopic);

        const upsertHandler = getRegisteredMethod("memory.upsert");
        assert.ok(upsertHandler);
        await upsertHandler.handler(
            makeCtx(
                { memoryStore: store },
                { workspace: "/tmp/ws", action: "replace", id: "user-role", content: "v2" },
            ),
        );

        const listHandler = getRegisteredMethod("memory.list");
        assert.ok(listHandler);
        const listResult = (await listHandler.handler(makeCtx({ memoryStore: store }))) as {
            topics: Array<{ id: string; updatedAt?: string }>;
        };

        const topic = listResult.topics.find((t) => t.id === "user-role");
        assert.ok(topic);
        assert.equal(typeof topic.updatedAt, "string");
        assert.ok(topic.updatedAt && topic.updatedAt.length > 0);
    });

    it("replace fails for unknown id", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");

        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "replace",
                id: "does-not-exist",
                content: "x",
            },
        );

        await assert.rejects(() => handler.handler(ctx), /unknown memory topic/);
    });

    it("remove deletes the topic and returns outcome=deleted", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        await store.appendEntry(sampleTopic);

        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);
        const ctx = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "remove",
                id: "user-role",
            },
        );
        const result = (await handler.handler(ctx)) as {
            ok: true;
            outcome: "created" | "updated" | "deleted";
        };
        assert.equal(result.outcome, "deleted");
        assert.equal(store.getTopic("user-role"), undefined);
    });

    it("rejects id with uppercase, path traversal, underscores, or over-length", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);

        for (const badId of ["../etc/passwd", "UPPER", "with space", "my_id", "x".repeat(65), ""]) {
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: badId,
                    name: "x",
                    content: "x",
                    type: "user",
                },
            );
            await assert.rejects(
                () => handler.handler(ctx),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal((err as { code?: string }).code, "invalid_params");
                    return true;
                },
                `bad id "${badId}" must be rejected`,
            );
        }
    });

    it("rejects non-string id with invalid_params", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);

        for (const badId of [null, undefined, 123, {}, []]) {
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: badId,
                    name: "x",
                    content: "x",
                    type: "user",
                },
            );
            await assert.rejects(
                () => handler.handler(ctx),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal((err as { code?: string }).code, "invalid_params");
                    return true;
                },
                `non-string id ${JSON.stringify(badId)} must be rejected`,
            );
        }
    });

    it("rejects add with name > 60 or content over the content cap", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);

        const badCases: Array<{ name?: string; content?: string }> = [
            { name: "x".repeat(61), content: "ok" },
            { name: "ok", content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) },
        ];
        for (const overrides of badCases) {
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: "valid-id",
                    name: "ok",
                    content: "ok",
                    type: "user",
                    ...overrides,
                },
            );
            await assert.rejects(
                () => handler.handler(ctx),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal((err as { code?: string }).code, "invalid_params");
                    return true;
                },
                `oversized ${JSON.stringify(overrides)} must reject`,
            );
        }
    });

    it("add uses explicit description when provided, falls back to name", async () => {
        const store = new LocalMemoryStore();
        store.initialize("ws-test");
        const handler = getRegisteredMethod("memory.upsert");
        assert.ok(handler);

        // With explicit description
        const ctx1 = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "add",
                id: "with-desc",
                name: "Name",
                description: "Custom desc",
                content: "body",
                type: "user",
            },
        );
        await handler.handler(ctx1);
        assert.equal(store.getTopic("with-desc")?.description, "Custom desc");

        // Without description → falls back to name
        const ctx2 = makeCtx(
            { memoryStore: store },
            {
                workspace: "/tmp/ws",
                action: "add",
                id: "no-desc",
                name: "Name",
                content: "body",
                type: "feedback",
            },
        );
        await handler.handler(ctx2);
        assert.equal(store.getTopic("no-desc")?.description, "Name");
    });
});
