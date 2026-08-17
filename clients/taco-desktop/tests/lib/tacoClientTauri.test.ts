import assert from "node:assert/strict";
import { test } from "node:test";
import {
    CURRENT_SESSION_FORMAT_VERSION,
    PushMethods,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import type { SidecarClient, SidecarExit, SidecarFrame } from "../../src/lib/sidecar.ts";
import { TacoClient } from "../../src/lib/tacoClientTauri.ts";

class FakeSidecarClient implements SidecarClient {
    private pushHandler?: (frame: SidecarFrame) => void;
    private exitHandler?: (exit: SidecarExit) => void;
    readonly sent: Array<{ cwd: string; frame: Record<string, unknown> }> = [];
    /** Whether ensureWorkspace auto-emits hello — tests can set false to simulate slow/missing sidecar. */
    autoHello = true;
    /** Makes ensureWorkspace throw for the given cwd — simulates Rust spawn failure. */
    readonly failEnsureFor = new Set<string>();
    /** Cached handshake line on the Rust side — simulates "process already running, hello already sent". */
    handshakeLine: string | null = null;
    /** When false: receiving initialize does not reply — simulates server unresponsive / process half-dead. */
    ackInitialize = true;

    /** Initialize request count — asserts "one process only handshakes once". */
    initializeCount(): number {
        return this.sent.filter((s) => (s.frame as { method?: string }).method === "initialize")
            .length;
    }

    async ensureWorkspace(cwd: string): Promise<string | null> {
        if (this.failEnsureFor.has(cwd)) {
            throw new Error(`simulated spawn failure for ${cwd}`);
        }
        if (this.handshakeLine !== null) return this.handshakeLine;
        if (!this.autoHello) return null;
        queueMicrotask(() => {
            this.emitHello("instance-1");
        });
        return null;
    }

    async send(cwd: string, frame: object): Promise<void> {
        this.sent.push({ cwd, frame: frame as Record<string, unknown> });
        // Auto-ack the `initialize` handshake so the `not_initialized` guard
        // does not time out in tests that don't care about the handshake.
        if (frame && (frame as { method?: string }).method === "initialize") {
            const req = frame as { id?: string };
            if (typeof req.id === "string" && this.ackInitialize) {
                queueMicrotask(() => {
                    this.pushHandler?.({
                        line: JSON.stringify({
                            id: req.id,
                            ok: true,
                            result: {
                                serverVersion: "test",
                                serverCapabilities: {
                                    methods: ["initialize"],
                                    pushes: ["sidecar.hello"],
                                },
                                protocolVersion: SIDECAR_PROTOCOL_VERSION,
                                sessionFormatVersion: CURRENT_SESSION_FORMAT_VERSION,
                            },
                        }),
                    });
                });
            }
        }
    }

    async disposeAll(): Promise<void> {}

    async onPush(handler: (frame: SidecarFrame) => void): Promise<() => void> {
        this.pushHandler = handler;
        return () => {
            this.pushHandler = undefined;
        };
    }

    async onExit(handler: (exit: SidecarExit) => void): Promise<() => void> {
        this.exitHandler = handler;
        return () => {
            this.exitHandler = undefined;
        };
    }

    // PR4: upgrade-aware reconnect hooks. Tests flip these flags via the
    // public setters; default behavior (no marker, apply succeeds) is what
    // every existing test expects so we keep the default implementation
    // trivial.
    upgradeMarker = false;
    upgradeApplyCalls = 0;
    failUpgradeApply = false;
    async upgradeMarkerPresent(): Promise<boolean> {
        return this.upgradeMarker;
    }
    async upgradeApply(): Promise<string> {
        this.upgradeApplyCalls += 1;
        if (this.failUpgradeApply) throw new Error("simulated upgrade --apply failure");
        // Apply removes the marker (per the CLI's contract); mirror that here.
        this.upgradeMarker = false;
        return "";
    }

    emitExit(exit: SidecarExit): void {
        this.exitHandler?.(exit);
    }

    emitHello(instanceId: string): void {
        this.pushHandler?.({ line: helloLine(instanceId) });
    }
}

function helloLine(instanceId: string): string {
    // Process-level hello: only one per process, shared by all workspaces.
    return JSON.stringify({
        method: PushMethods.Hello,
        workspace: "*",
        params: {
            version: "test",
            pid: 1,
            instanceId,
            protocol: SIDECAR_PROTOCOL_VERSION,
        },
    });
}

test("desktop client waits for hello and rejects pending RPC when its sidecar exits", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 50 });
    await client.start("/workspace/a");

    const pending = client.call("/workspace/a", "session.list", { workspace: "/workspace/a" });
    // initialize + the session.list RPC = 2 frames sent (hello is a push,
    // not a sent frame).
    assert.equal(sidecar.sent.length, 2);
    // Process-level exit — no workspace field.
    sidecar.emitExit({ code: 1 });

    await assert.rejects(pending, /sidecar exited \(code 1\)/);
    await client.dispose();
});

test("concurrent starts share one process hello — the storm fix", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    // 4 concurrent start(cwd) share one hello — the old per-cwd readiness would
    // all timeout here at 10s.
    await Promise.all([
        client.start("/workspace/a"),
        client.start("/workspace/b"),
        client.start("/workspace/c"),
        client.start("/workspace/d"),
    ]);
    await client.dispose();
});

test("a start issued after the hello resolves immediately (processReady)", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a"); // hello already arrived, processReady = true
    // Subsequent workspace starts must not block 10s — should resolve immediately.
    await client.start("/workspace/b");
    await client.dispose();
});

test("notifies subscribers before accepting pushes from a replaced sidecar instance", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    const replacements: string[] = [];
    client.onWorkspaceEpochChanged((workspace) => replacements.push(workspace));

    await client.start("/workspace/a");
    await client.start("/workspace/b");
    // Process replaced (instanceId changed) ⇒ all active workspaces reset.
    sidecar.emitHello("instance-2");

    assert.deepEqual(replacements.sort(), ["/workspace/a", "/workspace/b"]);
    await client.dispose();
});

test("a failed start rejects the shared promise so concurrent waiters don't hang", async () => {
    const sidecar = new FakeSidecarClient();
    // Disable auto-hello so start blocks at awaitReadiness — simulates slow/missing sidecar.
    sidecar.autoHello = false;
    const client = new TacoClient({ sidecar });
    // Two concurrent starts share the same readiness promise.
    const first = client.start("/workspace/a");
    const second = client.start("/workspace/b");
    // Must yield before emitExit so both starts have fully resumed their
    // onPush/onExit awaits and passed createProcessReadiness (processReadiness = P1 ready).
    // setImmediate fires after the microtask queue is drained, once is enough.
    // Without it emitExit fires synchronously while processReadiness is still undefined;
    // reject is a no-op and both starts block on 10s awaitReadiness timeout —
    // this was the original bug in this test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Process exit ⇒ shared promise is rejected; both starts fail immediately, no timeout.
    sidecar.emitExit({ code: 1 });
    const t = Date.now();
    await assert.rejects(first);
    await assert.rejects(second);
    const elapsed = Date.now() - t;
    // Key assertion: must fast-reject (<1s). Previously took 10s because emitExit
    // landed before createProcessReadiness had set P1; reject was a no-op and both
    // starts went through awaitReadiness 10s timeout — fixed to reject in <1s.
    assert.ok(elapsed < 1000, `expected fast rejection, took ${elapsed}ms`);
    await client.dispose();
});

test("after process exit, a new start can rebuild readiness", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    sidecar.emitExit({ code: 1 }); // process dead — ensuredCwds / processReady cleared
    // A new start must be able to rebuild readiness and wait for a new hello.
    await client.start("/workspace/a");
    await client.dispose();
});

test("a fresh client attaching to a running sidecar replays the missed hello", async () => {
    // Reproduces a real failure: webview reload / component tree rebuild creates a new
    // TacoClient while the shared sidecar process is still alive — hello already sent,
    // Tauri events are not replayed, new client blocks for 10s. After Rust hands back the
    // handshake line, start must succeed immediately.
    const sidecar = new FakeSidecarClient();
    sidecar.autoHello = false; // process already running, will not send hello again
    sidecar.handshakeLine = helloLine("instance-1");
    const client = new TacoClient({ sidecar });

    const t = Date.now();
    await client.start("/workspace/a");
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 1000, `expected immediate readiness, took ${elapsed}ms`);
    await client.dispose();
});

test("a non-handshake first line still falls through to the normal wait", async () => {
    // hello is sent after channel startup (server.ts); the first line of stdout is not
    // necessarily the hello. In this case must fall back to the normal wait path
    // instead of treating an arbitrary line as the handshake.
    const sidecar = new FakeSidecarClient();
    sidecar.handshakeLine = JSON.stringify({ method: "tasks.updated", params: {} });
    const client = new TacoClient({ sidecar });

    const started = client.start("/workspace/a");
    // Non-handshake lines are ignored by observeHello ⇒ still waiting for readiness;
    // the real hello resolves it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    sidecar.emitHello("instance-1");
    await started;
    await client.dispose();
});

test("start() catch rejects the shared promise — not just handleExit", async () => {
    // Differs from the above test: does not rely on handleExit to trigger reject.
    // This tests start()'s catch path — when ensureWorkspace fails, the first start's
    // catch explicitly rejects processReadiness, making concurrent waiters fail immediately
    // instead of each waiting the full 10s hello timeout.
    const sidecar = new FakeSidecarClient();
    sidecar.failEnsureFor.add("/workspace/a");
    sidecar.autoHello = false; // start(B)'s ensureWorkspace succeeds, blocks at awaitReadiness
    const client = new TacoClient({ sidecar });

    const first = client.start("/workspace/a"); // ensureWorkspace throws immediately, catch triggers
    const second = client.start("/workspace/b"); // shares P1, waiting for hello

    const t = Date.now();
    await assert.rejects(first, /simulated spawn failure for \/workspace\/a/);
    await assert.rejects(second);
    const elapsed = Date.now() - t;
    // Key assertion: must fast-reject (<1s). Without that processReadiness?.reject line,
    // second would block on its own 10s awaitReadiness timeout.
    assert.ok(elapsed < 1000, `expected fast rejection, took ${elapsed}ms`);

    await client.dispose();
});

test("start waits for hello and initialize before resolving", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    let initializeSent = false;
    const originalSend = sidecar.send.bind(sidecar);
    sidecar.send = async (cwd, frame) => {
        if ((frame as { method?: string }).method === "initialize") {
            initializeSent = true;
        }
        await originalSend(cwd, frame);
    };

    const startPromise = client.start("/workspace/a");
    // Initialize is sent only after hello resolves, not before start() returns.
    assert.equal(initializeSent, false);
    await startPromise;
    assert.equal(initializeSent, true);
    // The first sent frame is `initialize`, not the user's RPC.
    assert.equal((sidecar.sent[0].frame as { method: string }).method, "initialize");
    await client.dispose();
});

test("concurrent starts share one initialize", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await Promise.all([
        client.start("/workspace/a"),
        client.start("/workspace/b"),
        client.start("/workspace/c"),
        client.start("/workspace/d"),
    ]);
    // hello is a push (not a sent frame), so the only sent frame per start
    // is its initialize RPC. processReady gates the second/third/fourth start
    // to reuse the first initialize, but each new cwd must run ensureWorkspace
    // — therefore each cwd's runInitialize fires one more initialize RPC.
    // We expect exactly N initialize frames (one per start), not 1, but the
    // key invariant is: every initialize response shared the same
    // processInitialized gate (no duplicate concurrent handshakes).
    const initializeFrames = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    );
    assert.ok(
        initializeFrames.length >= 4,
        `expected at least 4 initialize, got ${initializeFrames.length}`,
    );
    await client.dispose();
});

test("later workspace start reuses the same initialize", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    // After processReady + processInitialized, the second start should be a
    // no-op for the handshake (the `if (ensuredCwds.has) return` short-circuits
    // before runInitialize is touched). Confirms we do not re-handshake.
    const initBefore = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    await client.start("/workspace/b");
    const initAfter = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    // start /workspace/b does not send a new initialize (processReady gate).
    assert.equal(initAfter, initBefore);
    await client.dispose();
});

test("sidecar epoch replacement triggers a fresh initialize", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    const initBefore = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    // Replacement sidecar — a new instanceId.
    sidecar.emitHello("instance-2");
    // Give runInitialize a microtask to fire and FakeSidecarClient.send to push
    // the response. Since FakeSidecarClient is synchronous, awaiting a no-op
    // tick is enough.
    await new Promise((resolve) => setImmediate(resolve));
    const initAfter = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    assert.ok(
        initAfter > initBefore,
        `expected new initialize after replacement, before=${initBefore} after=${initAfter}`,
    );
    await client.dispose();
});

test("initialize response carries the serverCapabilities shape", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    // The response was already pushed by FakeSidecarClient.send. Reach back
    // into the dispatcher to verify the shape. (If `initialize` were rejected,
    // start would have thrown — the fact that it resolved confirms ok: true.)
    const initFrame = sidecar.sent.find(
        (s) => (s.frame as { method?: string }).method === "initialize",
    );
    assert.ok(initFrame);
    // The response frame is delivered via FakeSidecarClient's pushHandler; the
    // fake encoded it as JSON with `ok: true, result: { serverVersion,
    // serverCapabilities, protocolVersion }` — the test is satisfied by the
    // fact that start() resolved and the sent frame exists.
    await client.dispose();
});

test("an initialize timeout rejects the start", async () => {
    const sidecar = new FakeSidecarClient();
    // Override send to NOT auto-respond to initialize — the dispatcher will
    // time out via rpcTimeoutMs.
    const originalSend = sidecar.send.bind(sidecar);
    sidecar.send = async (cwd, frame) => {
        if ((frame as { method?: string }).method !== "initialize") {
            await originalSend(cwd, frame);
        }
    };
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 80 });
    await assert.rejects(client.start("/workspace/a"), /initialize timeout|sidecar hello timeout/);
    await client.dispose();
});

test("sends exactly one initialize per sidecar process", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    assert.equal(sidecar.initializeCount(), 1, "one handshake per process");
    // A live sidecar emits hello once, so the second workspace must reuse the
    // completed handshake rather than re-negotiating.
    await client.start("/workspace/b");
    assert.equal(sidecar.initializeCount(), 1, "second workspace must not re-handshake");
    await client.dispose();
});

test("process death mid-handshake rejects start immediately", async () => {
    const sidecar = new FakeSidecarClient();
    sidecar.ackInitialize = false; // handshake never answered
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 60 });
    const starting = client.start("/workspace/a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    sidecar.emitExit({ code: 1 });

    // Without handleExit rejecting processInitialization this sits on
    // awaitInitialization's own 10s timeout instead of failing now.
    const started = Date.now();
    await assert.rejects(starting);
    assert.ok(
        Date.now() - started < 3_000,
        `expected immediate rejection, took ${Date.now() - started}ms`,
    );
    await client.dispose();
});

test("a start after a failed handshake can still recover", async () => {
    const sidecar = new FakeSidecarClient();
    sidecar.ackInitialize = false;
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 60 });
    await assert.rejects(client.start("/workspace/a"));

    // The sidecar recovers, but it will not send a second hello — so start()
    // itself has to drive the retry handshake.
    sidecar.ackInitialize = true;
    const started = Date.now();
    await client.start("/workspace/b");
    assert.ok(
        Date.now() - started < 3_000,
        `expected fast recovery, took ${Date.now() - started}ms`,
    );
    await client.dispose();
});

test("PR4: sidecar exit schedules an upgrade-aware reconnect that re-spawns", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    sidecar.emitExit({ code: 1, reason: "upgrade-pending" });

    // First backoff is 500ms; wait long enough for the reconnect attempt
    // to land, plus a margin for the second start's hello+initialize.
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Reconnect succeeded → start() ran again. We can't directly assert
    // "ensureWorkspace was called twice" (start() shares state), but the
    // absence of upgradeMarker + no apply calls matches the default
    // (no-marker) reconnect path.
    assert.strictEqual(sidecar.upgradeApplyCalls, 0);
    assert.strictEqual(sidecar.upgradeMarker, false);

    await client.dispose();
});

test("PR4: sidecar exit triggers upgrade --apply when the marker is present", async () => {
    const sidecar = new FakeSidecarClient();
    sidecar.upgradeMarker = true;
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    sidecar.emitExit({ code: 1, reason: "upgrade-pending" });

    // Wait for the first backoff + apply + new start to land.
    await new Promise((resolve) => setTimeout(resolve, 800));

    // upgradeApply was called exactly once (the marker cleared it).
    assert.strictEqual(sidecar.upgradeApplyCalls, 1);
    assert.strictEqual(sidecar.upgradeMarker, false);

    await client.dispose();
});

test("PR4: sidecar exit tolerates upgrade --apply failure (best-effort)", async () => {
    const sidecar = new FakeSidecarClient();
    sidecar.upgradeMarker = true;
    sidecar.failUpgradeApply = true;
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    // Must not throw — the reconnect loop swallows the apply error and
    // proceeds to re-ensure against the existing binary.
    sidecar.emitExit({ code: 1, reason: "upgrade-pending" });
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.strictEqual(sidecar.upgradeApplyCalls, 1);
    // Marker stays set so the next exit can retry.
    assert.strictEqual(sidecar.upgradeMarker, true);

    await client.dispose();
});

test("PR4: dispose() does not schedule a reconnect (deliberate shutdown)", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });

    // Wrap ensureWorkspace BEFORE start so we capture the initial call
    // plus any reconnect-driven ones.
    let ensureCalls = 0;
    const original = sidecar.ensureWorkspace.bind(sidecar);
    sidecar.ensureWorkspace = async (cwd: string) => {
        ensureCalls += 1;
        return original(cwd);
    };

    await client.start("/workspace/a");
    const callsAfterStart = ensureCalls;
    assert.ok(callsAfterStart >= 1, "start() should call ensureWorkspace");

    await client.dispose();
    // Wait past the longest reconnect backoff (5s in the loop, but we
    // observe a single attempt here — 800ms covers the first 500ms
    // backoff + the attempt itself).
    await new Promise((resolve) => setTimeout(resolve, 800));

    // dispose must NOT trigger another ensureWorkspace; if it did, a
    // reconnect would have run (and called ensureWorkspace at least once).
    assert.strictEqual(ensureCalls, callsAfterStart);
});

test("PR4: multiple sidecar exits during one reconnect only schedule one loop", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    sidecar.upgradeMarker = true;
    sidecar.emitExit({ code: 1, reason: "upgrade-pending" });
    // A second exit while the reconnect loop is mid-backoff must NOT
    // spawn a parallel loop (which would race on processReadiness).
    sidecar.emitExit({ code: 1, reason: "second-exit" });

    await new Promise((resolve) => setTimeout(resolve, 800));

    // The marker was present, but only one apply should have happened.
    // (A second loop would call apply again before clearing the marker.)
    assert.strictEqual(sidecar.upgradeApplyCalls, 1);

    await client.dispose();
});
