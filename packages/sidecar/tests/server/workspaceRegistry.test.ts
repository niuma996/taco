import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { WorkspaceRegistry } from "../../src/server/workspaceRegistry.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const key = asWorkspaceId("/workspace");
function runtime(dispose: () => Promise<void> = async () => {}) {
    return { dispose } as WorkspaceRuntime;
}

test("publishes a completed build once for concurrent ensure calls", async () => {
    let builds = 0;
    const ws = runtime();
    const registry = new WorkspaceRegistry(async () => {
        builds++;
        return ws;
    });
    const [a, b] = await Promise.all([registry.ensure(key), registry.ensure(key)]);
    assert.equal(a, ws);
    assert.equal(b, ws);
    assert.equal(await registry.ensure(key), ws);
    assert.equal(builds, 1);
});

test("ensure waits for closing runtime instead of reusing it", async () => {
    const gate = deferred();
    const started = deferred();
    const old = runtime(async () => {
        started.resolve();
        await gate.promise;
    });
    const next = runtime();
    const registry = new WorkspaceRegistry(async () => next);
    registry.publish(key, old);
    const closing = registry.remove(key);
    await started.promise;
    let resolved = false;
    const ensured = registry.ensure(key).then((ws) => {
        resolved = true;
        return ws;
    });
    await new Promise((done) => setImmediate(done));
    assert.equal(registry.get(key), undefined);
    assert.equal(resolved, false);
    gate.resolve();
    await closing;
    assert.equal(await ensured, next);
});

test("remove invalidates an in-flight build and disposes its resources", async () => {
    const gate = deferred();
    const started = deferred();
    let disposed = 0;
    const registry = new WorkspaceRegistry(async () => {
        started.resolve();
        await gate.promise;
        return runtime(async () => {
            disposed++;
        });
    });
    const building = registry.ensure(key);
    const rejected = assert.rejects(building, /closed|invalidated/);
    await started.promise;
    const closing = registry.remove(key);
    gate.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(disposed, 1);
    assert.deepEqual(registry.keys(), []);
});

test("concurrent removes dispose once", async () => {
    const gate = deferred();
    let disposed = 0;
    const ws = runtime(async () => {
        disposed++;
        await gate.promise;
    });
    const registry = new WorkspaceRegistry(async () => ws);
    registry.publish(key, ws);
    const a = registry.remove(key);
    const b = registry.remove(key);
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(disposed, 1);
});

test("disposeAll attempts every runtime even after a disposal failure", async () => {
    let disposed = 0;
    const registry = new WorkspaceRegistry(async () => runtime());
    registry.publish(
        key,
        runtime(async () => {
            throw new Error("close failed");
        }),
    );
    registry.publish(
        asWorkspaceId("/other"),
        runtime(async () => {
            disposed++;
        }),
    );
    await assert.rejects(registry.disposeAll(), /close|dispos/i);
    assert.equal(disposed, 1);
    assert.deepEqual(registry.keys(), []);
    assert.ok(await registry.ensure(key));
});

test("shutdown rejects waiting ensure calls until the registry is restarted", async () => {
    const gate = deferred();
    const started = deferred();
    const registry = new WorkspaceRegistry(async () => runtime());
    registry.publish(
        key,
        runtime(async () => {
            started.resolve();
            await gate.promise;
        }),
    );
    const closing = registry.disposeAll();
    await started.promise;
    const waiting = registry.ensure(key);
    const rejected = assert.rejects(waiting, /stopped/);
    const stopped = registry.stop();
    gate.resolve();
    await Promise.all([closing, stopped, rejected]);
    await assert.rejects(registry.ensure(key), /stopped/);
    registry.start();
    assert.ok(await registry.ensure(key));
});

test("failed construction is retryable without retaining a dead entry", async () => {
    let builds = 0;
    const registry = new WorkspaceRegistry(async () => {
        if (++builds === 1) throw new Error("build failed");
        return runtime();
    });
    await assert.rejects(registry.ensure(key), /build failed/);
    assert.ok(await registry.ensure(key));
    assert.equal(builds, 2);
});
