import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";

describe("session.snapshot.get", () => {
    it("retries until the history and main-session state share a stable sequence watermark", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        const taskStore = createTaskStore("/workspace");
        const attached = {
            taskStore,
            planState: { active: true, currentSlug: "plan-1" },
        };
        let historyReads = 0;
        const sequenceSamples = [4, 5, 6, 6];
        server.ensureWorkspace = async () =>
            ({
                listSessions: async () => [{ id: "main", metadata: { kind: "main" } }],
                getHistory: async () => {
                    historyReads++;
                    return {
                        leafEntryId: null,
                        entries: [
                            {
                                id: "entry-1",
                                parentId: null,
                                type: "message",
                                message: { role: "assistant", content: "hello" },
                                timestamp: "2026-08-01T00:00:00.000Z",
                            },
                        ],
                    };
                },
                getAttached: () => attached,
                attach: async () => assert.fail("attached session should be reused"),
            }) as never;
        server.getSessionLastSeq = () => sequenceSamples.shift() ?? 6;

        const response = await server.dispatchRpc({
            id: "snapshot-main",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "main" },
        });

        assert.deepEqual(response, {
            id: "snapshot-main",
            ok: true,
            result: {
                sessionId: "main",
                sessionKind: "main",
                snapshotSeq: 6,
                history: {
                    sessionId: "main",
                    leafEntryId: null,
                    entries: [
                        {
                            id: "entry-1",
                            parentId: null,
                            type: "message",
                            payload: { role: "assistant", content: "hello" },
                            timestamp: "2026-08-01T00:00:00.000Z",
                        },
                    ],
                },
                tasks: { active: null, history: [] },
                planState: { active: true, currentSlug: "plan-1" },
            },
        });
        assert.equal(historyReads, 2);
    });

    it("returns a subagent history snapshot without attaching main-session tools", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        let attachCalls = 0;
        server.ensureWorkspace = async () =>
            ({
                listSessions: async () => [{ id: "child", metadata: { kind: "subagent" } }],
                getHistory: async () => ({ leafEntryId: null, entries: [] }),
                getAttached: () => undefined,
                attach: async () => {
                    attachCalls++;
                    return assert.fail("subagent snapshots must not attach main-session tools");
                },
            }) as never;
        server.getSessionLastSeq = () => 3;

        const response = await server.dispatchRpc({
            id: "snapshot-child",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "child" },
        });

        assert.deepEqual(response, {
            id: "snapshot-child",
            ok: true,
            result: {
                sessionId: "child",
                sessionKind: "subagent",
                snapshotSeq: 3,
                history: { sessionId: "child", leafEntryId: null, entries: [] },
            },
        });
        assert.equal(attachCalls, 0);
    });

    it("resolves the session kind by exact id, not a prefix match", async () => {
        // Two sessions where one id is a prefix of the requested id. A
        // startsWith() lookup would misclassify the requested main session as
        // the subagent whose id happens to be its prefix.
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        let attachCalls = 0;
        server.ensureWorkspace = async () =>
            ({
                listSessions: async () => [
                    { id: "0199", metadata: { kind: "subagent" } },
                    { id: "0199abcd", metadata: { kind: "main" } },
                ],
                getHistory: async () => ({ leafEntryId: null, entries: [] }),
                getAttached: () => ({
                    taskStore: createTaskStore("/workspace"),
                    planState: { active: false, currentSlug: null },
                }),
                attach: async () => {
                    attachCalls++;
                    return assert.fail("main session should be reused, not re-attached");
                },
            }) as never;
        server.getSessionLastSeq = () => 2;

        const response = await server.dispatchRpc({
            id: "snapshot-exact",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "0199abcd" },
        });

        assert.equal(response.ok, true);
        assert.equal((response as { result: { sessionKind: string } }).result.sessionKind, "main");
        assert.equal(attachCalls, 0);
    });

    it("resolves a unique short id as a subagent without attaching main-session tools", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        let attachCalls = 0;
        server.ensureWorkspace = async () =>
            ({
                listSessions: async () => [{ id: "child-full-id", metadata: { kind: "subagent" } }],
                getHistory: async () => ({ leafEntryId: null, entries: [] }),
                getAttached: () => undefined,
                attach: async () => {
                    attachCalls++;
                    return assert.fail("subagent snapshots must not attach main-session tools");
                },
            }) as never;
        server.getSessionLastSeq = () => 3;

        const response = await server.dispatchRpc({
            id: "snapshot-child-short-id",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "child" },
        });

        assert.equal(response.ok, true);
        assert.equal(
            (response as { result: { sessionKind: string } }).result.sessionKind,
            "subagent",
        );
        assert.equal(attachCalls, 0);
    });

    it("rejects an ambiguous short id instead of guessing a session kind", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        server.ensureWorkspace = async () =>
            ({
                listSessions: async () => [
                    { id: "child-a", metadata: { kind: "subagent" } },
                    { id: "child-b", metadata: { kind: "main" } },
                ],
                getHistory: async () => assert.fail("ambiguous ids must not read history"),
                getAttached: () => assert.fail("ambiguous ids must not read attached state"),
                attach: async () => assert.fail("ambiguous ids must not attach"),
            }) as never;

        const response = await server.dispatchRpc({
            id: "snapshot-ambiguous-short-id",
            method: "session.snapshot.get",
            params: { workspace: "/workspace", sessionId: "child" },
        });

        assert.deepEqual(response, {
            id: "snapshot-ambiguous-short-id",
            ok: false,
            error: {
                code: "invalid_params",
                message: "session id prefix is ambiguous: child",
                data: undefined,
            },
        });
    });
});
