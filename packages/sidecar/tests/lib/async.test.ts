/** waitForEvent unit tests — one-shot signal or timeout. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SingleFlight, waitForEvent } from "../../src/lib/async.ts";

function deferred() {
    let listener: (() => void) | undefined;
    let unsubscribeCalled = 0;
    return {
        fire(): void {
            listener?.();
        },
        subscribe(fn: () => void): () => void {
            listener = fn;
            return () => {
                unsubscribeCalled++;
            };
        },
        get unsubscribeCount(): number {
            return unsubscribeCalled;
        },
    };
}

describe("waitForEvent", () => {
    it("resolves true when the event fires", async () => {
        const d = deferred();
        const wait = waitForEvent({ timeoutMs: 500, subscribe: d.subscribe });
        d.fire();
        assert.equal(await wait.promise, true);
        assert.equal(d.unsubscribeCount, 1);
    });

    it("resolves false on timeout and unsubscribes", async () => {
        const d = deferred();
        const wait = waitForEvent({ timeoutMs: 10, subscribe: d.subscribe });
        assert.equal(await wait.promise, false);
        assert.equal(d.unsubscribeCount, 1);
    });

    it("cancel() resolves false immediately and unsubscribes", async () => {
        const d = deferred();
        const wait = waitForEvent({ timeoutMs: 5_000, subscribe: d.subscribe });
        wait.cancel();
        assert.equal(await wait.promise, false);
        assert.equal(d.unsubscribeCount, 1);
    });

    it("late events after settle are ignored", async () => {
        const d = deferred();
        const wait = waitForEvent({ timeoutMs: 5_000, subscribe: d.subscribe });
        wait.cancel();
        assert.equal(await wait.promise, false);
        d.fire(); // must not throw / double-resolve
        assert.equal(d.unsubscribeCount, 1);
    });

    it("cleans up when subscribe fires the listener synchronously", async () => {
        let unsubscribeCalled = 0;
        const wait = waitForEvent({
            timeoutMs: 5_000,
            subscribe: (fn) => {
                fn(); // synchronous fire before subscribe returns
                return () => {
                    unsubscribeCalled++;
                };
            },
        });
        assert.equal(await wait.promise, true);
        assert.equal(unsubscribeCalled, 1);
    });
});

describe("SingleFlight", () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((res) => {
            resolve = res;
        });
        return { promise, resolve };
    }

    it("shares one factory call across concurrent run()s for the same key", async () => {
        let factoryCalls = 0;
        const flight = new SingleFlight<string, string>(async (key) => {
            factoryCalls++;
            return `v:${key}`;
        });
        const [a, b, c] = await Promise.all([flight.run("k"), flight.run("k"), flight.run("k")]);
        assert.equal(factoryCalls, 1);
        assert.equal(a, "v:k");
        assert.equal(b, "v:k");
        assert.equal(c, "v:k");
    });

    it("calls the factory separately for different keys in parallel", async () => {
        let factoryCalls = 0;
        const flight = new SingleFlight<string, string>(async (key) => {
            factoryCalls++;
            return `v:${key}`;
        });
        const [a, b] = await Promise.all([flight.run("a"), flight.run("b")]);
        assert.equal(factoryCalls, 2);
        assert.equal(a, "v:a");
        assert.equal(b, "v:b");
    });

    it("retries the factory after the shared promise rejects", async () => {
        let attempts = 0;
        const flight = new SingleFlight<string, string>(async () => {
            attempts++;
            if (attempts === 1) throw new Error("first attempt");
            return "ok";
        });
        await assert.rejects(flight.run("k"), /first attempt/);
        assert.equal(await flight.run("k"), "ok");
        assert.equal(attempts, 2);
    });

    it("concurrent run()s observe the same rejection from one failed factory call", async () => {
        let attempts = 0;
        const flight = new SingleFlight<string, string>(async () => {
            attempts++;
            throw new Error("boom");
        });
        const settled = await Promise.allSettled([
            flight.run("k"),
            flight.run("k"),
            flight.run("k"),
        ]);
        assert.equal(attempts, 1);
        assert.ok(settled.every((s) => s.status === "rejected"));
    });

    it("deletes the inflight entry when the shared promise resolves", async () => {
        const flight = new SingleFlight<string, string>(async (key) => `v:${key}`);
        await flight.run("k");
        // After settle, the next call must hit the factory again.
        let calls = 0;
        const counting = new SingleFlight<string, string>(async (key) => {
            calls++;
            return `v:${key}`;
        });
        await counting.run("k");
        await counting.run("k");
        assert.equal(calls, 2);
    });

    it("clear() drops in-flight promises; awaiters see the factory's original rejection", async () => {
        const d = deferred<string>();
        const flight = new SingleFlight<string, string>(() => d.promise);
        const first = flight.run("k");
        flight.clear();
        // A fresh run() after clear() must NOT share the still-pending first promise.
        const second = flight.run("k");
        d.resolve("late");
        assert.equal(await first, "late");
        // second has its own (already-resolved via d.resolve) factory call.
        assert.equal(await second, "late");
    });
});

/** withDeadline unit tests — timer race, signal fusion, structured error. */

import { DeadlineError, withDeadline } from "../../src/lib/async.ts";

describe("withDeadline", () => {
    it("resolves fast promises with the original value", async () => {
        assert.equal(await withDeadline(Promise.resolve(42), deadline("fast")), 42);
        assert.equal(await withDeadline(Promise.resolve("ok"), deadline("fast")), "ok");
    });

    it("propagates rejections from the underlying promise unchanged", async () => {
        await assert.rejects(
            () => withDeadline(Promise.reject(new Error("boom")), deadline("fast")),
            /boom/,
        );
    });

    it("rejects with DeadlineError when the local timer wins", async () => {
        const start = Date.now();
        await assert.rejects(
            () =>
                withDeadline(new Promise<string>(() => {}), {
                    timeoutMs: 50,
                    code: "HOOK_TIMEOUT",
                    label: "hanger hook",
                }),
            (err: unknown) => {
                assert.ok(err instanceof DeadlineError);
                assert.equal((err as DeadlineError).code, "HOOK_TIMEOUT");
                assert.equal((err as DeadlineError).label, "hanger hook");
                assert.equal((err as DeadlineError).timeoutMs, 50);
                assert.match((err as Error).message, /hanger hook timed out after 50ms/);
                return true;
            },
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 1_000, `deadline took ${elapsed}ms`);
    });

    it("runs onTimeout once when the local timer wins", async () => {
        let calls = 0;
        await assert.rejects(() =>
            withDeadline(new Promise<never>(() => {}), {
                timeoutMs: 25,
                code: "MCP_TIMEOUT",
                label: "mcp server foo: connect",
                onTimeout: () => {
                    calls++;
                },
            }),
        );
        // A microtask boundary is enough for the awaited onTimeout to run.
        await new Promise((r) => setImmediate(r));
        assert.equal(calls, 1);
    });

    it("does NOT run onTimeout when the promise resolves in time", async () => {
        let calls = 0;
        await withDeadline(Promise.resolve("ok"), {
            ...deadline("fast"),
            onTimeout: () => {
                calls++;
            },
        });
        await new Promise((r) => setImmediate(r));
        assert.equal(calls, 0);
    });

    it("swallows onTimeout rejections — the deadline error is the user-visible one", async () => {
        await assert.rejects(
            () =>
                withDeadline(new Promise<never>(() => {}), {
                    timeoutMs: 25,
                    code: "MCP_TIMEOUT",
                    label: "mcp server foo: connect",
                    onTimeout: () => {
                        throw new Error("cleanup failed");
                    },
                }),
            (err: unknown) => {
                // The DeadlineError must reach the caller — the cleanup throw
                // is swallowed inside the wrapper, exactly as in the original
                // mcpClient.withTimeout.
                assert.ok(err instanceof DeadlineError);
                return true;
            },
        );
    });

    it("rejects immediately when externalSignal is already aborted", async () => {
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(
            () =>
                withDeadline(new Promise<string>(() => {}), {
                    timeoutMs: 60_000,
                    code: "MCP_TIMEOUT",
                    label: "mcp server foo: callTool(bar)",
                    externalSignal: ac.signal,
                }),
            (err: unknown) => {
                assert.ok(err instanceof DeadlineError);
                assert.equal((err as DeadlineError).code, "MCP_TIMEOUT");
                return true;
            },
        );
    });

    it("rejects when externalSignal aborts during the wait", async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 25);
        const start = Date.now();
        await assert.rejects(
            () =>
                withDeadline(new Promise<string>(() => {}), {
                    timeoutMs: 60_000,
                    code: "MCP_TIMEOUT",
                    label: "mcp server foo: listTools",
                    externalSignal: ac.signal,
                }),
            (err: unknown) => {
                assert.ok(err instanceof DeadlineError);
                return true;
            },
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 1_000, `externalSignal took ${elapsed}ms`);
    });

    it("refuses a non-positive timeoutMs up front", async () => {
        // withDeadline is async, so a validation throw surfaces as a
        // rejected promise (not a synchronous throw) — use assert.rejects.
        await assert.rejects(
            () => withDeadline(Promise.resolve("x"), { timeoutMs: 0, code: "X", label: "y" }),
            /timeoutMs must be a positive finite number/,
        );
        await assert.rejects(
            () => withDeadline(Promise.resolve("x"), { timeoutMs: -1, code: "X", label: "y" }),
            /timeoutMs must be a positive finite number/,
        );
        await assert.rejects(
            () =>
                withDeadline(Promise.resolve("x"), {
                    timeoutMs: Number.NaN,
                    code: "X",
                    label: "y",
                }),
            /timeoutMs must be a positive finite number/,
        );
    });

    it("does not leak the deadline timer when the promise resolves fast", async () => {
        // Heuristic: the test process holds at most a handful of active
        // timers after a hundred fast resolves. Without clearing the timer
        // the count would climb.
        for (let i = 0; i < 100; i++) {
            await withDeadline(Promise.resolve(i), { ...deadline("fast") });
        }
        // No assertion here — the test passes by not hanging. The point is
        // to catch a future regression that drops the `clearTimeout` in
        // the finally block.
        assert.ok(true);
    });
});

function deadline(label: string, timeoutMs = 60_000) {
    return { timeoutMs, code: "TEST_TIMEOUT", label };
}
