/** Consolidated from 5 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { RpcResponse } from "@taco-ai/protocol";
import {
    agentsContentSchema,
    agentsListSchema,
    agentsWriteSchema,
    asSessionId,
    asWorkspaceId,
    channelsBindSchema,
    channelsListSchema,
    checkpointsRestoreSchema,
    commandPermissionResolveSchema,
    extensionsStatusSchema,
    imPolicyClearChatOverrideSchema,
    imPolicySetChannelDefaultSchema,
    imPolicySetChatOverrideSchema,
    isCompatibleSidecarProtocol,
    jobsCreateSchema,
    jobsDeleteSchema,
    jobsGetSchema,
    jobsHistorySchema,
    jobsListSchema,
    jobsRunNowSchema,
    jobsUpdateSchema,
    mcpCreateConfigSchema,
    mcpDeleteConfigSchema,
    mcpUpdateConfigSchema,
    memoryDeleteTopicSchema,
    memoryUpsertSchema,
    memoryWriteSchema,
    providerListModelsSchema,
    providersListSchema,
    providersRevealKeySchema,
    providerTestConnectionSchema,
    SIDECAR_PROTOCOL_VERSION,
    sessionCreateSchema,
    sessionEventsGetSchema,
    sessionHistorySchema,
    sessionListModelsSchema,
    sessionListSchema,
    sessionPlanStateGetSchema,
    sessionPromptSchema,
    sessionSnapshotGetSchema,
    sessionSteerSchema,
    sessionTaskHistoryGetSchema,
    sessionTasksGetSchema,
    settingsGetSchema,
    settingsWriteSchema,
    skillContentSchema,
    skillsListSchema,
    toolsListSchema,
    workspaceDisposeSchema,
    workspaceEnsureSchema,
    workspaceListSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { Value } from "typebox/value";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import {
    getRegisteredMethod,
    listRegisteredMethods,
    registerAdhocMethod,
} from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";
import { normalizeError, redactUpstreamMessage } from "../../src/server/rpcResponse.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { parseJsonPointer } from "../../src/server/validation.ts";
import { WorkspaceRegistry } from "../../src/server/workspaceRegistry.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("initialize", () => {
    let probeCalls = 0;
    registerAdhocMethod(
        "test.probe",
        false,
        async () => {
            probeCalls++;
            return { ok: true };
        },
        { command: true },
    );

    function initializeFrame(id: string, minor = 0): string {
        return JSON.stringify({
            id,
            method: "initialize",
            params: {
                protocolVersion: { major: 2, minor },
                clientCapabilities: { uiLocale: "en" },
            },
        });
    }

    /** Boots a server on an in-memory transport. */
    async function bootServer(): Promise<{ server: SidecarServer; transport: InMemoryTransport }> {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        const transport = new InMemoryTransport();
        await server.start(transport, []);
        return { server, transport };
    }

    /** Drives one request through the stdio boundary and returns its response. */
    async function sendLine(transport: InMemoryTransport, raw: string): Promise<RpcResponse> {
        const before = transport.sent.length;
        transport.simulateRequest(raw);
        const frames = await transport.waitForPushCount(before + 1);
        return frames[frames.length - 1] as RpcResponse;
    }

    describe("initialize handshake (stdio boundary)", () => {
        it("rejects ordinary RPC before initialize", async () => {
            probeCalls = 0;
            const { transport } = await bootServer();
            const resp = await sendLine(
                transport,
                JSON.stringify({ id: "req-1", method: "test.probe", commandId: "c1", params: {} }),
            );
            assert.equal(resp.ok, false);
            if (!resp.ok) assert.equal(resp.error.code, "not_initialized");
            assert.equal(probeCalls, 0, "handler must not run before initialize");
        });

        it("returns server version, capabilities, protocol version, and identity", async () => {
            const { transport } = await bootServer();
            const resp = await sendLine(transport, initializeFrame("init-1"));
            assert.equal(resp.ok, true);
            if (!resp.ok) return;
            const result = resp.result as {
                serverVersion: string;
                serverCapabilities: { methods: string[]; pushes: string[] };
                protocolVersion: { major: number; minor: number };
                instanceId: string;
                pid: number;
            };
            assert.equal(typeof result.serverVersion, "string");
            assert.ok(result.serverCapabilities.methods.includes("initialize"));
            // v2 dropped the `sidecar.hello` push frame; the hello-shaped
            // identity fields now travel on the initialize response.
            assert.equal(result.serverCapabilities.pushes.includes("sidecar.hello"), false);
            assert.deepEqual(result.protocolVersion, SIDECAR_PROTOCOL_VERSION);
            // Pinned separately: a bump must be a deliberate edit here too.
            assert.deepEqual(SIDECAR_PROTOCOL_VERSION, { major: 2, minor: 7 });
            assert.equal(typeof result.instanceId, "string");
            assert.equal(typeof result.pid, "number");
        });

        it("lets ordinary RPC through after initialize", async () => {
            probeCalls = 0;
            const { transport } = await bootServer();
            await sendLine(transport, initializeFrame("init-1"));
            const probe = await sendLine(
                transport,
                JSON.stringify({ id: "p1", method: "test.probe", commandId: "pc1", params: {} }),
            );
            assert.equal(probe.ok, true);
            assert.equal(probeCalls, 1);
        });

        it("rejects incompatible client major and stays uninitialized", async () => {
            const { transport } = await bootServer();
            const resp = await sendLine(
                transport,
                JSON.stringify({
                    id: "bad",
                    method: "initialize",
                    params: { protocolVersion: { major: 0, minor: 9 }, clientCapabilities: {} },
                }),
            );
            assert.equal(resp.ok, false);
            if (!resp.ok) assert.equal(resp.error.code, "incompatible_protocol");
            const blocked = await sendLine(
                transport,
                JSON.stringify({ id: "b1", method: "test.probe", commandId: "bc1", params: {} }),
            );
            assert.equal(blocked.ok, false);
            if (!blocked.ok) assert.equal(blocked.error.code, "not_initialized");
        });

        it("rejects a client minor newer than the server", async () => {
            const { transport } = await bootServer();
            // Derived from the constant so a minor bump can't turn this into an
            // accepted handshake (a hardcoded 2 silently passed at 2.2).
            const resp = await sendLine(
                transport,
                initializeFrame("init-future", SIDECAR_PROTOCOL_VERSION.minor + 1),
            );
            assert.equal(resp.ok, false);
            if (!resp.ok) assert.equal(resp.error.code, "incompatible_protocol");
        });

        it("a 2.7 client refuses a 2.6 daemon (it ignores the session search query)", () => {
            // Client-side gate: a 2.6 daemon answers ok to session.list while
            // ignoring `query`, so a search would silently list every session.
            // The handshake must fail before that silent drop.
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 5 }), false);
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 6 }), false);
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 7 }), true);
            // A newer sidecar is additive; the client ignores methods it lacks.
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 8 }), true);
        });

        it("accepts an older compatible client minor", async () => {
            probeCalls = 0;
            const { transport } = await bootServer();
            const init = await sendLine(transport, initializeFrame("init-old", 0));
            assert.equal(init.ok, true);
            const probe = await sendLine(
                transport,
                JSON.stringify({ id: "p1", method: "test.probe", commandId: "pc1", params: {} }),
            );
            assert.equal(probe.ok, true);
            assert.equal(probeCalls, 1);
        });

        it("rejects a malformed protocolVersion", async () => {
            const { transport } = await bootServer();
            const resp = await sendLine(
                transport,
                JSON.stringify({
                    id: "bad",
                    method: "initialize",
                    params: { protocolVersion: { major: "1", minor: 0 }, clientCapabilities: {} },
                }),
            );
            assert.equal(resp.ok, false);
            if (!resp.ok) assert.equal(resp.error.code, "invalid_params");
        });

        it("is repeatable", async () => {
            const { transport } = await bootServer();
            assert.equal((await sendLine(transport, initializeFrame("init-1"))).ok, true);
            assert.equal((await sendLine(transport, initializeFrame("init-2"))).ok, true);
        });

        it("guard runs before command idempotency", async () => {
            probeCalls = 0;
            const { transport } = await bootServer();
            // Pre-init request carries a commandId; it must be rejected without
            // leaving a commandRecords entry.
            const blocked = await sendLine(
                transport,
                JSON.stringify({
                    id: "pre",
                    method: "test.probe",
                    commandId: "shared",
                    params: {},
                }),
            );
            assert.equal(blocked.ok, false);
            await sendLine(transport, initializeFrame("init-1"));
            // Same commandId now executes (no command_id_conflict) — proof the
            // pre-init attempt never recorded.
            const after = await sendLine(
                transport,
                JSON.stringify({
                    id: "post",
                    method: "test.probe",
                    commandId: "shared",
                    params: {},
                }),
            );
            assert.equal(after.ok, true);
            assert.equal(probeCalls, 1);
        });

        it("stop() resets initialization state", async () => {
            const { server, transport } = await bootServer();
            await sendLine(transport, initializeFrame("init-1"));
            assert.equal(
                (
                    await sendLine(
                        transport,
                        JSON.stringify({
                            id: "ok",
                            method: "test.probe",
                            commandId: "k",
                            params: {},
                        }),
                    )
                ).ok,
                true,
            );
            await server.stop();
            await server.start(transport, []);
            const afterStop = await sendLine(
                transport,
                JSON.stringify({
                    id: "blocked",
                    method: "test.probe",
                    commandId: "k2",
                    params: {},
                }),
            );
            assert.equal(afterStop.ok, false);
            if (!afterStop.ok) assert.equal(afterStop.error.code, "not_initialized");
        });
    });

    describe("in-process callers are exempt from the handshake", () => {
        it("dispatchRpc works without initialize (headless / IM-only sidecar)", async () => {
            probeCalls = 0;
            const { server } = await bootServer();
            // No initialize. IM channel ingress, ConversationRouter and the memory
            // self-RPC tool all reach the server this way and have no client to
            // handshake — gating them would silently break headless sidecars.
            const resp = await server.dispatchRpc({
                id: "in-proc",
                method: "test.probe",
                commandId: "ip1",
                params: {},
            });
            assert.equal(resp.ok, true, "in-process dispatchRpc must not be gated");
            assert.equal(probeCalls, 1);
        });

        it("in-process commandId dedup still applies without initialize", async () => {
            probeCalls = 0;
            const { server } = await bootServer();
            const first = await server.dispatchRpc({
                id: "a",
                method: "test.probe",
                commandId: "dup",
                params: {},
            });
            const retry = await server.dispatchRpc({
                id: "b",
                method: "test.probe",
                commandId: "dup",
                params: {},
            });
            assert.equal(first.ok, true);
            assert.equal(retry.ok, true);
            assert.equal(probeCalls, 1, "identical commandId must execute once");
        });
    });
});

describe("schemaValidation", () => {
    /**
     * Schema validation tests — cover the typebox schema plumbing wired into
     * `registerMethod` + `handleRpcRequest`.
     *
     * These tests cover schema coverage, JSON-pointer diagnostics, and each
     * domain's registered envelope shapes.
     */

    /**
     * Sibling test files register `test.*` probes into the module-level registry
     * singleton at import time. Filter them so these assertions survive a move to
     * a shared-process test runner.
     */
    const isTestProbe = (name: string) => name.startsWith("test.");
    const builtinMethods = () => listRegisteredMethods().filter((n) => !isTestProbe(n));

    describe("RPC schema coverage", () => {
        before(() => {
            registerBuiltinMethods();
        });

        it("every registered method has a schema attached", () => {
            const missing = builtinMethods().filter((name) => !getRegisteredMethod(name)?.schema);
            assert.deepEqual(missing, [], `methods missing schema: ${missing.join(", ")}`);
        });

        it("RPC constants map 1:1 to registered methods", () => {
            // The contract table lists every method the sidecar serves, so
            // adding a name there without registering it — or registering one
            // that is not in the table — fails here.
            const expected = Object.values(RPC).sort();
            assert.deepEqual(builtinMethods(), expected);
        });
    });

    describe("JSON pointer decoding", () => {
        it("decodes pointer tokens and RFC 6901 escapes", () => {
            assert.deepEqual(parseJsonPointer("/foo"), ["foo"]);
            assert.deepEqual(parseJsonPointer("/foo/bar"), ["foo", "bar"]);
            assert.deepEqual(parseJsonPointer("/attachments/0/url"), ["attachments", "0", "url"]);
            // ~1 → "/", ~0 → "~"
            assert.deepEqual(parseJsonPointer("/a~1b/c~0d"), ["a/b", "c~d"]);
        });

        it("returns [] for pointers that are not rooted at a token", () => {
            // Covers typebox reporting root-level errors with an empty instancePath.
            assert.deepEqual(parseJsonPointer(""), []);
            assert.deepEqual(parseJsonPointer("/"), []);
        });
    });

    describe("validation pipeline (with a real strict schema)", () => {
        // The registered schemas cannot exercise the reject path, so use a
        // hand-written strict schema to prove Value.Errors → parseJsonPointer
        // produces a usable wire `issues[]` shape.
        const strictSchema = {
            type: "object",
            required: ["workspace", "sessionId"],
            properties: {
                workspace: { type: "string" },
                sessionId: { type: "string" },
                nested: {
                    type: "object",
                    properties: { count: { type: "number" } },
                },
            },
        } as const;

        it("reports a missing required field", () => {
            const errors = Value.Errors(strictSchema, { workspace: "/tmp" });
            assert.ok(errors.length > 0, "missing sessionId should produce an error");
        });

        it("reports a nested type mismatch with a decodable path", () => {
            const errors = [
                ...Value.Errors(strictSchema, {
                    workspace: "/tmp",
                    sessionId: "s1",
                    nested: { count: "not-a-number" },
                }),
            ];
            assert.ok(errors.length > 0, "wrong nested type should produce an error");
            const paths = errors.map((e) => parseJsonPointer(e.instancePath));
            assert.ok(
                paths.some((p) => p.includes("nested") && p.includes("count")),
                `expected a nested/count path, got ${JSON.stringify(paths)}`,
            );
        });

        it("accepts a fully valid object", () => {
            const errors = Value.Errors(strictSchema, {
                workspace: "/tmp",
                sessionId: "s1",
                nested: { count: 3 },
            });
            assert.equal([...errors].length, 0);
        });
    });

    /**
     * Every RPC validates its envelope before the handler runs.
     *
     * Each entry lists an envelope the schema must reject and one it must
     * accept — a schema that accepts both is too loose to catch a malformed
     * call, and one that rejects both is too strict for the real caller.
     *
     * The no-argument methods are called without a `params` field, so their
     * schema has to accept `undefined` as well as `{}`.
     */
    describe("RPC envelope validation", () => {
        const cases = [
            {
                method: "commandPermission.resolve",
                schema: commandPermissionResolveSchema,
                invalid: { workspace: "/w", requestId: "r" },
                valid: { workspace: "/w", requestId: "r", approved: true, scope: "once" },
            },
            {
                method: "imPolicy.setChannelDefault",
                schema: imPolicySetChannelDefaultSchema,
                invalid: { channelId: "c" },
                valid: { channelId: "c", patch: { tools: { fsTools: "deny" } } },
            },
            {
                method: "imPolicy.setChatOverride",
                schema: imPolicySetChatOverrideSchema,
                invalid: { channelId: "c", peerId: "p", patch: {} },
                valid: { channelId: "c", peerId: "p", chatId: "ch", patch: {} },
            },
            {
                method: "imPolicy.clearChatOverride",
                schema: imPolicyClearChatOverrideSchema,
                // The "peerId+chatId or chatKey" rule is a semantic one the
                // handler owns; the schema only checks the envelope shape,
                // so a malformed chatKey is what it rejects.
                invalid: { channelId: "c", chatKey: "not-a-sha256" },
                valid: { channelId: "c", peerId: "p", chatId: "ch" },
            },
            {
                method: "memory.write",
                schema: memoryWriteSchema,
                invalid: { workspace: "/w", content: "x" },
                valid: { workspace: "/w", content: "x", baseHash: "h" },
            },
            {
                method: "memory.deleteTopic",
                schema: memoryDeleteTopicSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", id: "topic" },
            },
            {
                method: "memory.upsert",
                schema: memoryUpsertSchema,
                invalid: { workspace: "/w", action: "add" },
                valid: { workspace: "/w", action: "add", id: "topic" },
            },
            {
                method: "mcp.createConfig",
                schema: mcpCreateConfigSchema,
                invalid: { config: { id: "srv" } },
                valid: { config: { id: "srv", transport: "stdio", command: "run" } },
            },
            {
                method: "mcp.updateConfig",
                schema: mcpUpdateConfigSchema,
                invalid: { id: "srv", patch: { transport: "carrier-pigeon" } },
                valid: { id: "srv", patch: { enabled: false } },
            },
            {
                method: "mcp.deleteConfig",
                schema: mcpDeleteConfigSchema,
                invalid: { id: "srv/../etc" },
                valid: { id: "srv" },
            },
            {
                method: "checkpoints.restore",
                schema: checkpointsRestoreSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", checkpointId: "cp1" },
            },
            {
                method: "session.list",
                schema: sessionListSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "session.create",
                schema: sessionCreateSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "session.create (image-only prompt)",
                schema: sessionCreateSchema,
                invalid: { workspace: "/w", initialImages: [42] },
                valid: {
                    workspace: "/w",
                    initialImages: [{ type: "image", data: "AAA", mimeType: "image/png" }],
                },
            },
            {
                method: "session.prompt",
                schema: sessionPromptSchema,
                invalid: {
                    workspace: "/w",
                    sessionId: "s1",
                    text: "inspect this",
                    images: [{ type: "image", data: "AAA" }],
                },
                valid: {
                    workspace: "/w",
                    sessionId: "s1",
                    text: "inspect this",
                    images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
                },
            },
            {
                method: "session.steer",
                schema: sessionSteerSchema,
                invalid: {
                    workspace: "/w",
                    sessionId: "s1",
                    text: "redirect",
                    images: [{ type: "text", data: "not an image", mimeType: "text/plain" }],
                },
                valid: {
                    workspace: "/w",
                    sessionId: "s1",
                    text: "redirect",
                    images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
                },
            },
            {
                method: "settings.write",
                schema: settingsWriteSchema,
                invalid: { global: null },
                valid: { global: { defaultModel: "x" } },
            },
            {
                method: "channels.bind",
                schema: channelsBindSchema,
                invalid: {},
                valid: { channelId: "c" },
            },
            {
                method: "agents.write",
                schema: agentsWriteSchema,
                invalid: { workspace: "", agentType: "Bad_Name" },
                valid: {
                    workspace: "/w",
                    agentType: "reviewer",
                    description: "Review code",
                    maxTurns: 10,
                    systemPrompt: "Be precise",
                },
            },
            {
                method: "workspace.ensure",
                schema: workspaceEnsureSchema,
                invalid: {},
                valid: { cwd: "/w" },
            },
            {
                method: "workspace.dispose",
                schema: workspaceDisposeSchema,
                invalid: { cwd: "" },
                valid: { cwd: "/w" },
            },
            {
                method: "providers.list",
                schema: providersListSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "providers.revealKey",
                schema: providersRevealKeySchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", providerId: "anthropic" },
            },
            {
                method: "session.listModels",
                schema: sessionListModelsSchema,
                invalid: { workspace: "/w", provider: 7 },
                valid: { workspace: "/w", provider: "anthropic" },
            },
            {
                method: "provider.listModels",
                schema: providerListModelsSchema,
                invalid: { providerId: "" },
                valid: { providerId: "custom:x" },
            },
            {
                method: "provider.testConnection",
                schema: providerTestConnectionSchema,
                invalid: { providerId: "custom:x" },
                valid: { providerId: "custom:x", modelId: "m" },
            },
            {
                method: "tools.list",
                schema: toolsListSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "skills.list",
                schema: skillsListSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "skills.content",
                schema: skillContentSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", filePath: "a/SKILL.md" },
            },
            {
                method: "agents.list",
                schema: agentsListSchema,
                invalid: {},
                valid: { workspace: "/w" },
            },
            {
                method: "agents.content",
                schema: agentsContentSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", agentType: "reviewer" },
            },
            {
                method: "session.history",
                schema: sessionHistorySchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", sessionId: "s1" },
            },
            {
                method: "session.events.get",
                schema: sessionEventsGetSchema,
                invalid: { workspace: "/w", sessionId: "s1" },
                valid: { workspace: "/w", sessionId: "s1", afterSeq: 0 },
            },
            {
                method: "session.snapshot.get",
                schema: sessionSnapshotGetSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", sessionId: "s1" },
            },
            {
                method: "session.tasks.get",
                schema: sessionTasksGetSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", sessionId: "s1" },
            },
            {
                method: "session.taskHistory.get",
                schema: sessionTaskHistoryGetSchema,
                invalid: { workspace: "/w", sessionId: "s1" },
                valid: { workspace: "/w", sessionId: "s1", listId: "l1" },
            },
            {
                method: "session.planState.get",
                schema: sessionPlanStateGetSchema,
                invalid: { workspace: "/w" },
                valid: { workspace: "/w", sessionId: "s1" },
            },
            {
                method: "jobs.list",
                schema: jobsListSchema,
                invalid: { actor: { kind: "im" } },
                valid: { actor: { kind: "im", channelId: "c", peerId: "p", chatId: "t" } },
            },
            {
                method: "jobs.get",
                schema: jobsGetSchema,
                invalid: { id: "bad/id" },
                valid: { id: "job-1" },
            },
            {
                method: "jobs.delete",
                schema: jobsDeleteSchema,
                invalid: {},
                valid: { id: "job-1" },
            },
            {
                method: "jobs.runNow",
                schema: jobsRunNowSchema,
                invalid: { id: "" },
                valid: { id: "job-1" },
            },
            {
                method: "jobs.history",
                schema: jobsHistorySchema,
                invalid: { id: 7 },
                valid: { id: "job-1" },
            },
            {
                method: "jobs.create",
                schema: jobsCreateSchema,
                // The id is optional on create — the daemon mints it.
                invalid: { job: { name: "n", command: "agent.invoke" } },
                valid: {
                    job: {
                        name: "n",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: {},
                        enabled: true,
                        run_on_startup: false,
                    },
                },
            },
            {
                method: "jobs.update",
                schema: jobsUpdateSchema,
                // The id is required on update — the body replaces a job.
                invalid: {
                    job: {
                        name: "n",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: {},
                        enabled: true,
                        run_on_startup: false,
                    },
                },
                valid: {
                    job: {
                        id: "job-1",
                        name: "n",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: {},
                        enabled: true,
                        run_on_startup: false,
                    },
                },
            },
        ];

        for (const { method, schema, invalid, valid } of cases) {
            it(`${method} rejects a malformed envelope`, () => {
                const errors = [...Value.Errors(schema, invalid)];
                assert.ok(errors.length > 0, `${method} accepted ${JSON.stringify(invalid)}`);
            });

            it(`${method} accepts a well-formed envelope`, () => {
                const errors = [...Value.Errors(schema, valid)];
                assert.equal(errors.length, 0, `${method} rejected ${JSON.stringify(valid)}`);
            });
        }

        // The no-argument methods travel without a `params` field.
        for (const [method, schema] of [
            ["workspace.list", workspaceListSchema],
            ["settings.get", settingsGetSchema],
            ["extensions.status", extensionsStatusSchema],
            ["channels.list", channelsListSchema],
        ] as const) {
            it(`${method} accepts a call with no params`, () => {
                const errors = [...Value.Errors(schema, undefined)];
                assert.equal(errors.length, 0, `${method} rejected an absent params`);
                assert.equal([...Value.Errors(schema, {})].length, 0, `${method} rejected {}`);
                assert.ok(
                    [...Value.Errors(schema, { bogus: 1 })].length > 0,
                    `${method} accepted an unknown field`,
                );
            });
        }
    });

    it("initialize remains permissive so malformed clients reach negotiation", () => {
        const schema = getRegisteredMethod(RPC.initialize)?.schema;
        assert.ok(schema, "initialize must have a schema");
        for (const input of [null, undefined, 42, "not-params", [1, 2, 3], {}]) {
            assert.equal([...Value.Errors(schema, input)].length, 0);
        }
    });
});

describe("normalizeError.redaction", () => {
    /**
     * Regression: normalizeError does not propagate upstream error.message.
     * Fix: RpcHandlerError returned as-is; other throwable → code=internal, message
     * = "[upstream] " + redact long tokens/UUIDs + truncate to 200 chars.
     */

    describe("redactUpstreamMessage", () => {
        it("returns placeholder for empty input", () => {
            assert.equal(redactUpstreamMessage(""), "[upstream] error");
        });

        it("truncates messages longer than 200 chars", () => {
            const long = "x".repeat(500);
            const out = redactUpstreamMessage(long);
            assert.match(out, /^\[upstream\] /);
            assert.ok(out.length <= 220, `expected <= 220, got ${out.length}`);
        });

        it("redacts long alphanumeric tokens (key-shaped)", () => {
            // Simulates Anthropic-style 401: tail carries the key
            const in_ = "Your api key: sk-ant-api03-abc123def456789012345 is invalid";
            const out = redactUpstreamMessage(in_);
            assert.match(out, /^\[upstream\] /);
            assert.ok(!out.includes("abc123def456789012345"), "key tail must be redacted");
            assert.match(out, /…XXXX/);
        });

        it("redacts long hex runs that look like request ids (32 hex chars)", () => {
            // No hyphens — strictly not a uuid, but 32 hex looks just as suspicious.
            // The long-token regex should catch it.
            const in_ = "request id 06ba832bdaad11a605d5fe50525b0d65 failed";
            const out = redactUpstreamMessage(in_);
            assert.ok(
                !out.includes("06ba832bdaad11a605d5fe50525b0d65"),
                "hex run must be redacted",
            );
            assert.match(out, /…XXXX/);
        });

        it("redacts dashed uuid-shaped strings", () => {
            const in_ = "request id 06ba832b-daad-11a6-05d5-fe50525b0d65 failed";
            const out = redactUpstreamMessage(in_);
            assert.ok(
                !out.includes("06ba832b-daad-11a6-05d5-fe50525b0d65"),
                "uuid must be redacted",
            );
            assert.match(out, /…uuid/);
        });

        it("leaves short normal messages untouched (besides the prefix)", () => {
            const in_ = "provider returned no models";
            const out = redactUpstreamMessage(in_);
            assert.equal(out, "[upstream] provider returned no models");
        });
    });

    describe("normalizeError", () => {
        function callWith(thrown: unknown): { code: string; message: string } {
            const resp = normalizeError("req-1", thrown);
            assert.equal(resp.id, "req-1");
            assert.equal(resp.ok, false);
            // narrowed
            if (resp.ok) throw new Error("unreachable");
            return { code: resp.error.code, message: resp.error.message };
        }

        it("SessionNotFoundError maps to not_found", async () => {
            const { SessionNotFoundError } = await import(
                "../../src/runtime/session/sessionLookup.ts"
            );
            const r = callWith(new SessionNotFoundError(asSessionId("gone")));
            assert.equal(r.code, "not_found");
            assert.equal(r.message, "session not found: gone");
        });

        it("RpcHandlerError passes through untouched (our own errors)", async () => {
            const { RpcHandlerError } = await import("../../src/server/methodRegistry.ts");
            const e = new RpcHandlerError("invalid_params", "settings.write: baseUrl is required");
            const r = callWith(e);
            assert.equal(r.code, "invalid_params");
            assert.equal(r.message, "settings.write: baseUrl is required");
        });

        it("upstream Error.message gets a [upstream] prefix and internal code", () => {
            // A typical upstream 401 carries key fields as JSON / error codes.
            // Redaction targets key-shaped tokens, not arbitrary upstream text (all possible
            // internal field names cannot be enumerated). This test only covers the two
            // guarantees: unified prefix + no upstream code exposure.
            const upstreamMsg = "request id abc123def type=authentication_error";
            const e = new Error(upstreamMsg);
            const r = callWith(e);
            assert.equal(r.code, "internal", "upstream code must not leak");
            assert.match(r.message, /^\[upstream\] /);
            // Middle content is passed through (for user diagnostics); only the boundary prefix is added
            assert.ok(r.message.includes("request id"));
        });

        it("long key-shaped tokens inside the message ARE redacted", () => {
            const e = new Error("Your api key: sk-ant-api03-abc123def456789012345xyz is invalid");
            const r = callWith(e);
            assert.ok(!r.message.includes("abc123def456789012345xyz"), "key tail must be redacted");
            assert.match(r.message, /…XXXX/);
        });

        it("non-Error throwables (string, number) are also redacted", () => {
            const r = callWith("just a string error");
            assert.equal(r.code, "internal");
            assert.equal(r.message, "[upstream] just a string error");

            const r2 = callWith(42);
            assert.equal(r2.code, "internal");
            assert.equal(r2.message, "[upstream] 42");
        });
    });
});

describe("workspaceRouting", () => {
    describe("workspace RPC routing", () => {
        it("routes workspace.ensure from params.cwd", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let ensured: string | undefined;
            server.ensureWorkspace = async (cwd) => {
                ensured = cwd;
                return { cwd } as never;
            };

            const response = await server.dispatchRpc({
                id: "ensure-1",
                method: "workspace.ensure",
                params: { cwd: "/tmp/project-a" },
            });

            assert.deepEqual(response, {
                id: "ensure-1",
                ok: true,
                result: { cwd: "/tmp/project-a" },
            });
            assert.equal(ensured, "/tmp/project-a");
        });

        it("routes workspace.dispose from params.cwd", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let disposed: string | undefined;
            server.disposeWorkspace = async (cwd) => {
                disposed = cwd;
            };

            const response = await server.dispatchRpc({
                id: "dispose-1",
                method: "workspace.dispose",
                params: { cwd: "/tmp/project-a" },
            });

            assert.deepEqual(response, { id: "dispose-1", ok: true, result: null });
            assert.equal(disposed, "/tmp/project-a");
        });
    });
});

describe("invalidateCompactionCaches.chain", () => {
    /**
     * Compaction cache invalidation integration test — verifies
     * SidecarServer.invalidateCompactionCaches() actually traverses the full
     * workspace registry → WorkspaceRuntime → SessionRegistry → AttachedSession →
     * CompactionController.invalidate() chain, rather than calling the wrong
     * method or no-oping.
     *
     * Strategy: inject fake workspaces with spy'd registries/sessions/controllers,
     * call invalidateCompactionCaches(), then assert every facade was called.
     */

    useTempTacoHome("facade-chain");

    function injectWorkspaces(
        workspaces: WorkspaceRegistry,
        entries: readonly [key: string, ws: unknown][],
    ): void {
        for (const [key, ws] of entries) {
            workspaces.publish(asWorkspaceId(key), ws as unknown as WorkspaceRuntime);
        }
    }

    interface FakeWorkspaceRuntime {
        invalidateCompactionCache: () => void;
    }

    interface FakeSessionRegistry {
        invalidateAllCompactionCaches: () => void;
    }

    interface FakeAttachedSession {
        invalidateCompactionCache: () => void;
    }

    interface FakeCompactionController {
        invalidate: () => void;
    }

    describe("SidecarServer.invalidateCompactionCaches — facade chain", () => {
        it("walks the workspace registry → workspace → sessionRegistry → session → controller", () => {
            const controller1 = makeControllerSpy();
            const controller2 = makeControllerSpy();
            const session1 = makeSessionSpy(controller1);
            const session2 = makeSessionSpy(controller2);
            const registry = makeRegistrySpy([session1, session2]);
            const workspace = makeWorkspaceSpy(registry);

            const workspaces = new WorkspaceRegistry(async () => {
                throw new Error("unexpected workspace build in test");
            });
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                workspaceRegistry: workspaces,
            });
            injectWorkspaces(workspaces, [["/proj/a", workspace]]);

            // Call the facade entry point
            server.invalidateCompactionCaches();

            // Every layer in the chain reaches its correct downstream target:
            assert.deepEqual(workspace.calls, ["invalidateCompactionCache"]);
            assert.deepEqual(registry.calls, ["invalidateAllCompactionCaches"]);
            assert.deepEqual(session1.calls, ["invalidateCompactionCache"]);
            assert.deepEqual(session2.calls, ["invalidateCompactionCache"]);
            assert.deepEqual(controller1.calls, ["invalidate"]);
            assert.deepEqual(controller2.calls, ["invalidate"]);
        });

        it("works with multiple workspaces across the chain", () => {
            const ws1Controller1 = makeControllerSpy();
            const ws1Controller2 = makeControllerSpy();
            const ws1Session1 = makeSessionSpy(ws1Controller1);
            const ws1Session2 = makeSessionSpy(ws1Controller2);
            const ws1Registry = makeRegistrySpy([ws1Session1, ws1Session2]);
            const ws1 = makeWorkspaceSpy(ws1Registry);

            const ws2Controller = makeControllerSpy();
            const ws2Session = makeSessionSpy(ws2Controller);
            const ws2Registry = makeRegistrySpy([ws2Session]);
            const ws2 = makeWorkspaceSpy(ws2Registry);

            const workspaces = new WorkspaceRegistry(async () => {
                throw new Error("unexpected workspace build in test");
            });
            const server = new SidecarServer({
                providerKeyStore: new ProviderKeyStore({}),
                workspaceRegistry: workspaces,
            });
            injectWorkspaces(workspaces, [
                ["/proj/one", ws1],
                ["/proj/two", ws2],
            ]);

            server.invalidateCompactionCaches();

            // ws1: 2 sessions × their own controller
            assert.equal(ws1.calls.length, 1);
            assert.equal(ws1Registry.calls.length, 1);
            assert.equal(ws1Session1.calls.length, 1);
            assert.equal(ws1Session2.calls.length, 1);
            assert.equal(ws1Controller1.calls.length, 1);
            assert.equal(ws1Controller2.calls.length, 1);

            // ws2: 1 session
            assert.equal(ws2.calls.length, 1);
            assert.equal(ws2Registry.calls.length, 1);
            assert.equal(ws2Session.calls.length, 1);
            assert.equal(ws2Controller.calls.length, 1);
        });

        it("no-op with no registered workspaces (still safe to call)", () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });

            // Must not throw
            server.invalidateCompactionCaches();
        });
    });

    // ─── spy factories ──────────────────────────────────────────────────────────────

    function makeControllerSpy(): FakeCompactionController & { calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            invalidate() {
                calls.push("invalidate");
            },
        };
    }

    function makeSessionSpy(
        controller: FakeCompactionController,
    ): FakeAttachedSession & { calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            invalidateCompactionCache() {
                calls.push("invalidateCompactionCache");
                controller.invalidate();
            },
        };
    }

    function makeRegistrySpy(
        sessions: FakeAttachedSession[],
    ): FakeSessionRegistry & { calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            invalidateAllCompactionCaches() {
                calls.push("invalidateAllCompactionCaches");
                for (const s of sessions) s.invalidateCompactionCache();
            },
        };
    }

    function makeWorkspaceSpy(
        registry: FakeSessionRegistry,
    ): FakeWorkspaceRuntime & { calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            invalidateCompactionCache() {
                calls.push("invalidateCompactionCache");
                registry.invalidateAllCompactionCaches();
            },
        };
    }
});
