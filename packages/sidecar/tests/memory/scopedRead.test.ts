import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { asWorkspaceId } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { LocalMemoryStore, workspaceKey } from "../../src/memory/local/store.ts";
import { NoOpMemoryStore } from "../../src/memory/noopStore.ts";
import { buildLayeredMemoryBlock, resolveMemorySources } from "../../src/memory/sources.ts";
import type { MemoryEntry, MemoryStore } from "../../src/memory/types.ts";
import type { Api, Model } from "../../src/runtime/pi/types.ts";
import { normalizeContext } from "../../src/runtime/pi/values.ts";
import { registerMemoryHandlers } from "../../src/server/handlers/memory.ts";
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";
import { createMemoryTool } from "../../src/tools/memory.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

const workspace = asWorkspaceId("im://mock/peer/chat");
const topic: MemoryEntry = {
    id: "shared-topic",
    name: "Shared topic",
    description: "Summary only",
    type: "project",
    content: "Current body",
    createdAt: "2026-11-10T00:00:00.000Z",
};

describe("scoped memory reads", () => {
    let home: string;
    let previousHome: string | undefined;
    let current: MemoryStore;
    let linked: LocalMemoryStore;
    let managed: LocalMemoryStore;
    let unrelated: LocalMemoryStore;
    let linkedRoot: string;
    let managedRoot: string;
    let roots: string[];
    let managedRoots: string[];
    let inheritManagedGlobal: boolean;

    before(() => registerMemoryHandlers());
    beforeEach(async () => {
        previousHome = process.env.TACO_HOME;
        home = mkdtempSync(join(tmpdir(), "taco-memory-read-"));
        process.env.TACO_HOME = home;
        const store = (identity: string) => {
            const value = new LocalMemoryStore();
            value.initialize(identity);
            return value;
        };
        current = store(workspace);
        linkedRoot = join(home, "linked");
        managedRoot = join(home, "managed");
        linked = store(linkedRoot);
        managed = store(managedRoot);
        unrelated = store(join(home, "unrelated"));
        await current.appendEntry(topic);
        await linked.appendEntry({ ...topic, content: "Inherited full body" });
        await managed.appendEntry({ ...topic, content: "Managed full body" });
        await unrelated.appendEntry({ ...topic, content: "Private full body" });
        roots = [linkedRoot];
        managedRoots = [managedRoot];
        inheritManagedGlobal = false;
    });
    afterEach(() => {
        if (previousHome === undefined) delete process.env.TACO_HOME;
        else process.env.TACO_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    });

    const options = () => ({
        store: current,
        target: "channel" as const,
        associatedRoots: roots,
        inheritManagedGlobal,
        managedGlobalRoots: managedRoots,
    });
    async function rpc(method: string, params: unknown): Promise<unknown> {
        const registered = getRegisteredMethod(method);
        assert.ok(registered, `${method} must be registered`);
        assert.equal(Value.Check(registered.schema as never, params), true, "valid RPC params");
        return registered.handler({
            workspace: {
                memoryStore: current,
                imRouting: { channelId: "mock", peerId: "peer", chatId: "chat" },
                associatedRoots: () => roots,
                inheritsManagedGlobalMemory: () => inheritManagedGlobal,
                managedGlobalMemoryRoots: () => managedRoots,
            },
            server: {},
            params,
        } as unknown as MethodCtx<unknown>);
    }
    const read = (memoryLayer: string, sourceId: string, id = topic.id) =>
        rpc("memory.read", { workspace, memoryLayer, sourceId, id }) as Promise<{
            topic: { content: string; readOnly: boolean };
        }>;

    it("preserves memory arguments in real Anthropic and OpenAI request serialization", async () => {
        for (const api of ["anthropic-messages", "openai-responses"] as const) {
            const model: Model<Api> = {
                id: "test-model",
                name: "Test model",
                api,
                provider: api === "anthropic-messages" ? "anthropic" : "openai",
                baseUrl: "https://example.invalid/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 1024,
            };
            const tool = createMemoryTool();
            let payload: unknown;
            const adapter =
                api === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi();
            const response = await adapter
                .streamSimple(
                    model,
                    normalizeContext({
                        systemPrompt: "Read memory",
                        tools: [
                            {
                                name: tool.name,
                                description: tool.description,
                                parameters: tool.parameters,
                            },
                        ],
                        messages: [
                            { role: "user", content: "Read the note", timestamp: Date.now() },
                        ],
                    }),
                    {
                        apiKey: "test-api-key",
                        onPayload: (value) => {
                            payload = value;
                            throw new Error("payload captured");
                        },
                        fetch: async () => {
                            throw new Error("unexpected network request");
                        },
                    },
                )
                .result();
            assert.match(response.errorMessage ?? "", /payload captured/);
            const request = payload as {
                tools?: Array<{
                    name?: string;
                    input_schema?: { type?: string; properties?: Record<string, unknown> };
                    parameters?: { type?: string; properties?: Record<string, unknown> };
                }>;
            };
            const serialized = request.tools?.find((entry) => entry.name === "memory");
            assert.ok(serialized, `${api} must serialize the memory tool`);
            const schema = serialized.input_schema ?? serialized.parameters;
            assert.equal(schema?.type, "object");
            for (const name of ["action", "id", "memoryLayer", "sourceId", "content"]) {
                assert.ok(schema?.properties?.[name], `${api} must retain ${name}`);
            }
        }
    });

    it("reads the injected inherited reference through the memory tool and RPC", async () => {
        const block = buildLayeredMemoryBlock(resolveMemorySources(options()));
        const references = [...block.matchAll(/memory\.read (\{[^\n]+\})/g)].map((match) =>
            JSON.parse(match[1] ?? "{}"),
        );
        const reference = references.find((value) => value.memoryLayer === "workspace");
        assert.ok(reference, "inherited summary must carry a usable scoped reference");
        assert.equal(reference.sourceId, workspaceKey(linkedRoot));
        assert.doesNotMatch(block, new RegExp(home));
        const tool = createMemoryTool();
        const input = { action: "read", ...reference };
        assert.equal(Value.Check(tool.parameters, input), true);
        const result = await invokeTool(tool, input, {
            workspace,
            call: (method: string, _workspace: unknown, params: unknown) => rpc(method, params),
        });
        assert.match(JSON.stringify(result.content), /Inherited full body/);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(home));
        assert.equal(linked.getTopic(topic.id)?.content, "Inherited full body");
    });

    it("disambiguates duplicate ids across the current, associated and managed layers", async () => {
        inheritManagedGlobal = true;
        assert.equal(
            (await read("current", workspaceKey(workspace))).topic.content,
            "Current body",
        );
        assert.equal((await read("workspace", linked.dirKey)).topic.content, "Inherited full body");
        assert.equal(
            (await read("managed-global", managed.dirKey)).topic.content,
            "Managed full body",
        );
        assert.equal((await read("workspace", linked.dirKey)).topic.readOnly, true);
        assert.equal((await read("current", workspaceKey(workspace))).topic.readOnly, false);
    });

    it("reads the opaque source references returned by memory.list", async () => {
        const result = (await rpc("memory.list", { workspace })) as {
            topics: Array<{ id: string; memoryLayer: string; sourceId: string }>;
        };
        assert.equal(result.topics.length, 2);
        for (const reference of result.topics) {
            assert.match(reference.sourceId, /^[0-9a-f]{16}$/);
            const value = await read(reference.memoryLayer, reference.sourceId, reference.id);
            assert.equal(
                value.topic.content,
                reference.memoryLayer === "current" ? "Current body" : "Inherited full body",
            );
        }
    });

    it("reads existing legacy ids without allowing those ids on new writes", async () => {
        const parameters = createMemoryTool().parameters;
        assert.equal(
            Value.Check(parameters, {
                action: "read",
                memoryLayer: "workspace",
                sourceId: linked.dirKey,
                id: "legacy_topic",
            }),
            true,
        );
        assert.equal(
            Value.Check(parameters, {
                action: "add",
                id: "legacy_topic",
                name: "Legacy",
                type: "project",
                content: "Body",
            }),
            false,
        );
        assert.equal(
            Value.Check(parameters, {
                action: "remove",
                id: topic.id,
                memoryLayer: "workspace",
                sourceId: linked.dirKey,
            }),
            false,
        );
        await linked.appendEntry({ ...topic, id: "legacy_topic", content: "Legacy body" });
        assert.equal(
            (await read("workspace", linked.dirKey, "legacy_topic")).topic.content,
            "Legacy body",
        );
        await assert.rejects(
            invokeTool(
                createMemoryTool(),
                {
                    action: "add",
                    id: "legacy_topic",
                    name: "Legacy",
                    type: "project",
                    content: "Body",
                },
                {
                    workspace,
                    sessionId: "reader",
                    call: () => assert.fail("invalid write must not reach RPC"),
                },
            ),
            /kebab-case/,
        );
    });

    it("refuses unrelated sources and immediately enforces revoked association grants", async () => {
        await read("workspace", linked.dirKey);
        await assert.rejects(read("workspace", unrelated.dirKey), /not available|not authorized/i);
        roots = [];
        await assert.rejects(read("workspace", linked.dirKey), /not available|not authorized/i);
        assert.doesNotMatch(
            buildLayeredMemoryBlock(resolveMemorySources(options())),
            /Inherited full body|Associated workspace/,
        );
    });

    it("requires managed-global opt-in on every read and rejects the wrong layer", async () => {
        await assert.rejects(
            read("managed-global", managed.dirKey),
            /not available|not authorized/i,
        );
        inheritManagedGlobal = true;
        await read("managed-global", managed.dirKey);
        await assert.rejects(read("workspace", managed.dirKey), /not available|not authorized/i);
        await assert.rejects(read("current", linked.dirKey), /not available|not authorized/i);
        managedRoots = [];
        await assert.rejects(
            read("managed-global", managed.dirKey),
            /not available|not authorized/i,
        );
        managedRoots = [managedRoot];
        inheritManagedGlobal = false;
        await assert.rejects(
            read("managed-global", managed.dirKey),
            /not available|not authorized/i,
        );
    });

    it("refuses disabled memory, unknown topics and invalid selectors without path access", async () => {
        await assert.rejects(read("workspace", linked.dirKey, "missing"), /not available|unknown/i);
        const registered = getRegisteredMethod("memory.read");
        assert.ok(registered);
        for (const params of [
            { workspace, memoryLayer: "other", sourceId: linked.dirKey, id: topic.id },
            { workspace, memoryLayer: "workspace", sourceId: linkedRoot, id: topic.id },
            { workspace, memoryLayer: "workspace", sourceId: linked.dirKey, id: "../secret" },
            {
                workspace,
                memoryLayer: "workspace",
                sourceId: linked.dirKey,
                id: topic.id,
                path: linkedRoot,
            },
        ])
            assert.equal(Value.Check(registered.schema as never, params), false);
        current = new NoOpMemoryStore();
        current.initialize(workspace);
        inheritManagedGlobal = true;
        await assert.rejects(read("workspace", linked.dirKey), /disabled/i);
        await assert.rejects(read("current", workspaceKey(workspace)), /disabled/i);
    });

    it("keeps writes on the current target and refuses inherited write selectors", async () => {
        await rpc("memory.upsert", {
            workspace,
            action: "replace",
            id: topic.id,
            content: "Current changed",
        });
        assert.equal(current.getTopic(topic.id)?.content, "Current changed");
        assert.equal(linked.getTopic(topic.id)?.content, "Inherited full body");
        await assert.rejects(
            invokeTool(
                createMemoryTool(),
                {
                    action: "remove",
                    id: topic.id,
                    memoryLayer: "workspace",
                    sourceId: linked.dirKey,
                },
                {
                    workspace,
                    sessionId: "memory-reader",
                    call: (method: string, _workspace: unknown, params: unknown) =>
                        rpc(method, params),
                },
            ),
            /read-only|only.*read/i,
        );
        assert.ok(current.getTopic(topic.id));
    });
});
