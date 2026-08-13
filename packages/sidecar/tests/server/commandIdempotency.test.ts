import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { registerMethod } from "../../src/server/methodRegistry.ts";
import { SidecarServer } from "../../src/server/server.ts";

/** Monotonic clock — advance() fakes time passing without touching wall-clock. */
class FakeClock {
    private t = 0;
    now = (): number => this.t;
    advance(ms: number): void {
        this.t += ms;
    }
}

let calls = 0;
registerMethod(
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
registerMethod(
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
registerMethod(
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

    it("pruneCommandRecords drops expired entries without a new RPC", async () => {
        boundedCalls = 0;
        const clock = new FakeClock();
        const server = new SidecarServer({
            providerKeyStore: new ProviderKeyStore({}),
            commandRecordLimit: 100,
            commandRecordTtlMs: 100,
            now: clock.now,
        });
        await server.dispatchRpc({
            id: "sweep-first",
            method: "test.bounded-command",
            commandId: "sweep-command",
            params: { value: "first" },
        });
        const internals = server as unknown as {
            commandRecords: Map<string, unknown>;
            pruneCommandRecords: () => void;
        };
        assert.equal(internals.commandRecords.size, 1);

        clock.advance(101);
        internals.pruneCommandRecords();
        assert.equal(
            internals.commandRecords.size,
            0,
            "expired entries must be swept even with no new RPC",
        );
    });
});

let turnCalls = 0;
registerMethod(
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
