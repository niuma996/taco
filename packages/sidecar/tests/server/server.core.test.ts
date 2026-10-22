/** Consolidated from 5 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { RpcResponse } from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    isCompatibleSidecarProtocol,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { Value } from "typebox/value";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import {
    getRegisteredMethod,
    listRegisteredMethods,
    registerMethod,
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
    registerMethod(
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
            assert.deepEqual(SIDECAR_PROTOCOL_VERSION, { major: 2, minor: 2 });
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

        it("a 2.2 client refuses a 2.1 daemon (it would drop model-list config fields)", () => {
            // Client-side gate: a 2.1 daemon answers settings.write ok while
            // discarding providerExtraModels / providerHiddenModels, so the
            // handshake must fail before any write can be lost.
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 1 }), false);
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 2 }), true);
            assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 3 }), true);
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
     * IMPORTANT: every registered schema is currently a `Type.Any()` /
     * `Type.Unknown()` placeholder, and those accept ANY value — so the
     * validation gate rejects nothing in production today. These tests
     * therefore split into two groups:
     *
     *   - Plumbing that is genuinely load-bearing now: schema coverage across
     *     all registered methods, and JSON-pointer decoding.
     *   - A pinned characterization of the placeholder behaviour, so that
     *     tightening a schema makes this file fail loudly instead of silently
     *     passing. See `placeholder schemas reject nothing (characterization)`.
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
            const missing = builtinMethods().filter(
                (name) => !getRegisteredMethod(name)?.options.schema,
            );
            assert.deepEqual(missing, [], `methods missing schema: ${missing.join(", ")}`);
        });

        it("RPC + JOBS_RPC constants map 1:1 to registered methods", async () => {
            // PR4: jobs.* lives in the scheduler module, not `@taco-ai/shared`.
            // Import the local constants here so the closure test enforces the
            // same invariant for jobs.* as for shared.* — adding a method name
            // to either side without wiring the other surfaces immediately.
            const { JOBS_RPC } = await import("../../src/scheduler/jobsRpc.ts");
            const expected = [...Object.values(RPC), ...Object.values(JOBS_RPC)].sort();
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

    describe("placeholder schemas reject nothing (characterization)", () => {
        before(() => {
            registerBuiltinMethods();
        });

        // These assertions pin the CURRENT no-op behaviour on purpose. When a
        // schema is tightened to Type.Object({...}), the matching case below will
        // start failing — that failure is the signal to update this file and the
        // schema's JSDoc together, not to loosen the schema again.
        const nonsenseInputs: Array<[string, unknown]> = [
            ["null", null],
            ["undefined", undefined],
            ["a number", 42],
            ["a string", "not-params"],
            ["an array", [1, 2, 3]],
            ["an empty object", {}],
        ];

        for (const method of [RPC.initialize, RPC.sessionPrompt, RPC.sessionCreate]) {
            it(`${method} still accepts nonsense inputs`, () => {
                const schema = getRegisteredMethod(method)?.options.schema;
                assert.ok(schema, `${method} must have a schema`);
                for (const [label, input] of nonsenseInputs) {
                    const errors: unknown[] = [...Value.Errors(schema, input)];
                    assert.equal(
                        errors.length,
                        0,
                        `${method} unexpectedly rejected ${label} — if this schema was intentionally tightened, update this characterization test and the schema's JSDoc note`,
                    );
                }
            });
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
