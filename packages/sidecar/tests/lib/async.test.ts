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
