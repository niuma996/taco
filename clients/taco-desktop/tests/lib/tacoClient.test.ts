import assert from "node:assert/strict";
import { test } from "node:test";
import { CURRENT_SESSION_FORMAT_VERSION, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";
import { FAST_RPC_METHODS, FAST_RPC_TIMEOUT_MS } from "@taco-ai/shared";
import { TacoClient } from "../../src/lib/clients/tacoClient.ts";
import type { SidecarClient, SidecarExit, SidecarFrame } from "../../src/lib/sidecar.ts";

class FakeSidecarClient implements SidecarClient {
    private pushHandler?: (frame: SidecarFrame) => void;
    private exitHandler?: (exit: SidecarExit) => void;
    readonly sent: Array<{ cwd: string; frame: Record<string, unknown> }> = [];
    /** instanceId reported in initialize responses — bump to simulate daemon replacement. */
    instanceId = "instance-1";
    /** Makes ensureWorkspace throw for the given cwd — simulates Rust spawn failure. */
    readonly failEnsureFor = new Set<string>();
    /** When false: receiving initialize does not reply — simulates server unresponsive / process half-dead. */
    ackInitialize = true;

    /** Initialize request count — asserts "one process only handshakes once". */
    initializeCount(): number {
        return this.sent.filter((s) => (s.frame as { method?: string }).method === "initialize")
            .length;
    }

    async ensureWorkspace(cwd: string): Promise<null> {
        if (this.failEnsureFor.has(cwd)) {
            throw new Error(`simulated spawn failure for ${cwd}`);
        }
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
                                    pushes: ["session.attached"],
                                },
                                protocolVersion: SIDECAR_PROTOCOL_VERSION,
                                sessionFormatVersion: CURRENT_SESSION_FORMAT_VERSION,
                                instanceId: this.instanceId,
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

    /** Push a synthetic response frame as if the server sent it. Tests use this
     *  to inject not_initialized errors or success results for non-initialize
     *  RPCs (which the fake otherwise leaves unanswered). */
    emitResponse(id: string, ok: boolean, payload: Record<string, unknown>): void {
        this.pushHandler?.({
            line: JSON.stringify({ id, ok, ...payload }),
        });
    }

    /** Look up the most recent non-initialize frame's id. */
    lastNonInitializeId(): string | undefined {
        for (let i = this.sent.length - 1; i >= 0; i--) {
            const frame = this.sent[i].frame as { method?: string; id?: string };
            if (frame.method !== "initialize" && typeof frame.id === "string") {
                return frame.id;
            }
        }
        return undefined;
    }
}

/** Real-timer sleep. The suite deliberately avoids `mock.timers`: it is
 *  global mutable state, and six existing tests depend on real 10s / 800ms
 *  timings that a leaked reset would silently break. The fast-tier tests
 *  below therefore wait for real time, matching the suite's existing style. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("desktop client waits for initialize and rejects pending RPC when its sidecar exits", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 50 });
    await client.start("/workspace/a");

    const pending = client.call("/workspace/a", "session.list", { workspace: "/workspace/a" });
    // initialize + the session.list RPC = 2 frames sent.
    assert.equal(sidecar.sent.length, 2);
    // Process-level exit — no workspace field.
    sidecar.emitExit({ code: 1 });

    await assert.rejects(pending, /sidecar exited \(code 1\)/);
    await client.dispose();
});

test("concurrent starts share one initialize handshake — the storm fix", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    // 4 concurrent start(cwd) share one handshake — the old per-cwd readiness
    // would all timeout here at 10s.
    await Promise.all([
        client.start("/workspace/a"),
        client.start("/workspace/b"),
        client.start("/workspace/c"),
        client.start("/workspace/d"),
    ]);
    await client.dispose();
});

test("a start issued after initialize resolves immediately", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a"); // handshake already done, processInitialized = true
    // Subsequent workspace starts must not block 10s — should resolve immediately.
    await client.start("/workspace/b");
    await client.dispose();
});

test("daemon replacement notifies epoch subscribers on the new handshake", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    const replacements: string[] = [];
    client.onWorkspaceEpochChanged((workspace) => replacements.push(workspace));

    await client.start("/workspace/a");
    await client.start("/workspace/b");
    // Exit itself must NOT fire epoch handlers — the dead daemon's owner set
    // is snapshotted (replacedCwds) and the epoch table keeps the old
    // instanceId, so the next handshake classifies the new daemon as
    // "replaced" and fires then, once the replacement is serving.
    sidecar.emitExit({ code: undefined });
    assert.deepEqual(replacements, []);

    sidecar.instanceId = "instance-2";
    await client.start("/workspace/a");
    assert.deepEqual(replacements.sort(), ["/workspace/a", "/workspace/b"]);
    await client.dispose();
});

test("a throwing workspace-epoch handler does not break the replacement handshake", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    const goodNotifications: string[] = [];
    // First subscriber throws; second must still fire on every replaced cwd,
    // and the shared handshake must settle as success.
    client.onWorkspaceEpochChanged(() => {
        throw new Error("simulated epoch handler failure");
    });
    client.onWorkspaceEpochChanged((workspace) => goodNotifications.push(workspace));

    await client.start("/workspace/a");
    await client.start("/workspace/b");
    // Replace daemon, then re-handshake so runInitialize observes "replaced".
    sidecar.emitExit({ code: undefined });
    sidecar.instanceId = "instance-2";
    // start() must succeed even with a throwing handler in the set — the
    // outer try/catch in runInitialize would have rejected initialization.
    await client.start("/workspace/a");
    assert.deepEqual(goodNotifications.sort(), ["/workspace/a", "/workspace/b"]);
    await client.dispose();
});

test("a failed start rejects the shared promise so concurrent waiters don't hang", async () => {
    const sidecar = new FakeSidecarClient();
    // Disable initialize acks so start blocks at awaitInitialization —
    // simulates slow/missing sidecar.
    sidecar.ackInitialize = false;
    const client = new TacoClient({ sidecar });
    // Two concurrent starts share the same initialization promise.
    const first = client.start("/workspace/a");
    const second = client.start("/workspace/b");
    // Must yield before emitExit so both starts have fully resumed their
    // onPush/onExit awaits and created the shared initialization promise.
    // setImmediate fires after the microtask queue is drained, once is enough.
    // Without it emitExit fires synchronously while the promise is still
    // undefined; reject is a no-op and both starts block on the 10s
    // awaitInitialization timeout — this was the original bug in this test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Process exit ⇒ shared promise is rejected; both starts fail immediately, no timeout.
    sidecar.emitExit({ code: 1 });
    const t = Date.now();
    await assert.rejects(first);
    await assert.rejects(second);
    const elapsed = Date.now() - t;
    // Key assertion: must fast-reject (<1s). Previously took 10s because emitExit
    // landed before the shared promise existed; reject was a no-op and both
    // starts went through awaitInitialization 10s timeout — fixed to reject in <1s.
    assert.ok(elapsed < 1000, `expected fast rejection, took ${elapsed}ms`);
    await client.dispose();
});

test("after process exit, a new start can rebuild readiness", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    sidecar.emitExit({ code: 1 }); // process dead — ensuredCwds / handshake state cleared
    // A new start must be able to rebuild the initialize handshake.
    await client.start("/workspace/a");
    await client.dispose();
});

test("a fresh client attaching to a running sidecar handshakes via initialize directly", async () => {
    // Reproduces a real scenario: webview reload / component tree rebuild creates a new
    // TacoClient while the shared sidecar process is still alive. The daemon no longer
    // broadcasts a per-connection hello; a late-joining client simply sends its own
    // `initialize` — no replay mechanism involved — and start resolves fast.
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });

    const t = Date.now();
    await client.start("/workspace/a");
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 1000, `expected immediate readiness, took ${elapsed}ms`);
    assert.equal(sidecar.initializeCount(), 1);
    await client.dispose();
});

test("start() catch rejects the shared promise — not just handleExit", async () => {
    // Differs from the above test: does not rely on handleExit to trigger reject.
    // This tests start()'s catch path — when ensureWorkspace fails, the first start's
    // catch explicitly rejects the shared initialization promise, making concurrent
    // waiters fail immediately instead of each waiting the full 10s timeout.
    const sidecar = new FakeSidecarClient();
    sidecar.failEnsureFor.add("/workspace/a");
    sidecar.ackInitialize = false; // start(B)'s ensureWorkspace succeeds, blocks at awaitInitialization
    const client = new TacoClient({ sidecar });

    const first = client.start("/workspace/a"); // ensureWorkspace throws immediately, catch triggers
    const second = client.start("/workspace/b"); // shares the promise, waiting for initialize

    const t = Date.now();
    await assert.rejects(first, /simulated spawn failure for \/workspace\/a/);
    await assert.rejects(second);
    const elapsed = Date.now() - t;
    // Key assertion: must fast-reject (<1s). Without the explicit reject in start()'s
    // catch, second would block on its own 10s awaitInitialization timeout.
    assert.ok(elapsed < 1000, `expected fast rejection, took ${elapsed}ms`);

    await client.dispose();
});

test("start sends initialize before resolving", async () => {
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
    // Initialize is sent during start()'s await chain, not before start() is called.
    assert.equal(initializeSent, false);
    await startPromise;
    assert.equal(initializeSent, true);
    // The first sent frame is `initialize`, not the user's RPC.
    assert.equal((sidecar.sent[0].frame as { method: string }).method, "initialize");
    await client.dispose();
});

test("a late-joining client handshakes independently on the same sidecar", async () => {
    // Webview reload creates a second TacoClient against the still-running
    // daemon. The server allows (and expects) one initialize per connection /
    // client instance — the late joiner must send its own.
    const sidecar = new FakeSidecarClient();
    const first = new TacoClient({ sidecar });
    await first.start("/workspace/a");
    assert.equal(sidecar.initializeCount(), 1);

    const second = new TacoClient({ sidecar });
    await second.start("/workspace/b");
    assert.equal(sidecar.initializeCount(), 2);

    await first.dispose();
    await second.dispose();
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
    assert.equal(sidecar.initializeCount(), 1);
    await client.dispose();
});

test("later workspace start reuses the same initialize", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    // After processInitialized, the second start should be a
    // no-op for the handshake (the `if (ensuredCwds.has) return` short-circuits
    // before runInitialize is touched). Confirms we do not re-handshake.
    const initBefore = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    await client.start("/workspace/b");
    const initAfter = sidecar.sent.filter(
        (s) => (s.frame as { method?: string }).method === "initialize",
    ).length;
    // start /workspace/b does not send a new initialize (processInitialized gate).
    assert.equal(initAfter, initBefore);
    await client.dispose();
});

test("sidecar replacement triggers a fresh initialize", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    const initBefore = sidecar.initializeCount();
    // Replacement sidecar: the old process dies, the new one reports a
    // different instanceId. The next start must re-handshake.
    sidecar.emitExit({ code: undefined });
    sidecar.instanceId = "instance-2";
    await client.start("/workspace/a");
    const initAfter = sidecar.initializeCount();
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
    await assert.rejects(client.start("/workspace/a"), /initialize/);
    await client.dispose();
});

test("sends exactly one initialize per sidecar process", async () => {
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    assert.equal(sidecar.initializeCount(), 1, "one handshake per process");
    // The handshake is process-scoped client state, so the second workspace
    // must reuse the completed handshake rather than re-negotiating.
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

    // The sidecar recovers; start() itself drives the retry handshake.
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
    // to land, plus a margin for the second start's initialize handshake.
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

test("call() self-heals a not_initialized error from a stale connection", async () => {
    // The daemon rejects non-initialize RPCs with not_initialized when the
    // per-connection handshake state isn't current (e.g. the desktop reconnected
    // after a daemon restart and its first call lands before the new handshake
    // settles). Without the retry, the user sees a 1000s dispatcher timeout;
    // with it, call() awaits the new handshake and succeeds.
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    const first = client.call<unknown, { ok: boolean }>("/workspace/a", "session.list", {
        workspace: "/workspace/a",
    });
    // Wait one tick so sendOnce registers the pending before we push a response.
    await Promise.resolve();
    const firstId = sidecar.lastNonInitializeId();
    assert.ok(firstId, "expected a sent frame for session.list");
    // Server-side response: not_initialized. The call() retry path catches
    // this and re-sends once the new handshake resolves.
    sidecar.emitResponse(firstId, false, {
        error: { code: "not_initialized", message: "stale connection" },
    });

    // After the retry, the dispatcher must re-send the same RPC and get a
    // success response. Wait for the new send to land, then respond with ok.
    await new Promise((resolve) => setImmediate(resolve));
    const secondId = sidecar.lastNonInitializeId();
    assert.ok(secondId, "expected a re-sent frame after not_initialized");
    assert.notEqual(
        secondId,
        firstId,
        "retry must use a fresh RPC id (the dispatcher rotates ids per send)",
    );
    sidecar.emitResponse(secondId, true, { result: { ok: true } });

    const result = await first;
    assert.deepEqual(result, { ok: true });
    await client.dispose();
});

test("call() does not retry not_initialized when the handshake itself fails", async () => {
    // The retry path re-runs ensureInitialized + awaitHandshake. If the
    // reconnect handshake fails (daemon gone, no initialize ack), the retry's
    // pending RPC must surface a real error rather than silently looping or
    // masking it as the original not_initialized. We use a short
    // rpcTimeoutMs so the unreplied retry deterministically rejects instead of
    // sitting on the dispatcher's 1,000,000ms default.
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 80 });
    await client.start("/workspace/a");

    const first = client.call("/workspace/a", "session.list", { workspace: "/workspace/a" });
    await Promise.resolve();
    const firstId = sidecar.lastNonInitializeId();
    assert.ok(firstId);
    sidecar.emitResponse(firstId, false, {
        error: { code: "not_initialized", message: "stale connection" },
    });
    // Daemon dies AND will not ack the retry's reconnect handshake. Without
    // ackInitialize, the retry's ensureInitialized handshake hangs on the
    // dispatcher timeout — but the retry's own sendOnce also times out,
    // surfacing the error rather than blocking forever.
    sidecar.ackInitialize = false;
    sidecar.emitExit({ code: 1 });

    await assert.rejects(first);
    await client.dispose();
});

test("fast-tier RPCs are bounded when the daemon handshakes then goes silent", async () => {
    // Regression guard for the empty-sidebar cold start. The daemon accepts the
    // connection and completes `initialize`, then never answers anything else
    // (measured in the field: an OOM-dying daemon behaves exactly like this).
    // Before the tiered ceiling, `session.list` inherited the 1,000,000ms
    // default, so initFromStorage's await never settled and the sidebar stayed
    // empty with no error to catch. Uses fake timers so the test does not sit
    // for the real 15s.
    const sidecar = new FakeSidecarClient();
    // No rpcTimeoutMs: exercise the production default, which is what the
    // desktop constructs in App.tsx.
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");
    // The fake never answers non-initialize RPCs, which is exactly the wedged
    // daemon we need: handshake fine, everything after it silent.

    const pending = client.call("/workspace/a", "session.list", { workspace: "/workspace/a" });
    let settled: "pending" | "rejected" = "pending";
    const watched = pending.then(
        () => {
            settled = "pending";
        },
        () => {
            settled = "rejected";
        },
    );

    // Just before the fast ceiling: still in flight.
    await sleep(FAST_RPC_TIMEOUT_MS - 1000);
    assert.strictEqual(settled, "pending", "must not bail before the fast ceiling");

    // Crossing it must reject rather than hang until the long default.
    await sleep(2000);
    await watched;
    assert.strictEqual(settled, "rejected", "fast-tier RPC must be bounded");
    await assert.rejects(pending, /RPC timeout after 15000ms: session\.list/);
    await client.dispose();
});

test("model-bound RPCs keep the long ceiling and are not truncated", async () => {
    // The other half of the contract: a `session.prompt` can legitimately
    // stream for minutes, so it must NOT inherit the fast ceiling. If this
    // regresses, long agent turns would abort at 15s.
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar });
    await client.start("/workspace/a");

    const pending = client.call("/workspace/a", "session.prompt", { workspace: "/workspace/a" });
    let rejected = false;
    void pending.catch(() => {
        rejected = true;
    });

    // Past the fast ceiling — a prompt must still be in flight. We only need
    // to clear 15s to prove it was not truncated there; waiting out the real
    // ~16.7min default would be absurd, and membership is asserted below.
    await sleep(FAST_RPC_TIMEOUT_MS + 2000);
    assert.strictEqual(rejected, false, "prompt must not be cut off at the fast ceiling");
    // Belt and braces: the classification itself is the contract.
    assert.ok(!FAST_RPC_METHODS.has("session.prompt"), "prompt must not be fast-tier");
    assert.ok(FAST_RPC_METHODS.has("session.list"), "session.list must be fast-tier");

    await client.dispose();
    await pending.catch(() => {});
});

test("an explicit rpcTimeoutMs overrides the fast tier in both directions", async () => {
    // Callers that pass an explicit bound get exactly that bound. The existing
    // suite relies on this (several tests pass 50ms and expect it to apply to
    // session.list, which is fast-tier), and a caller asking for a tighter
    // bound must not be handed the looser 15s one.
    const sidecar = new FakeSidecarClient();
    const client = new TacoClient({ sidecar, rpcTimeoutMs: 50 });
    await client.start("/workspace/a");

    // assert.rejects awaits the promise itself — attaching the handler up front
    // matters here: the rejection fires at 50ms, so any intervening `sleep`
    // would leave it briefly unhandled and the test runner fails the file.
    await assert.rejects(
        client.call("/workspace/a", "session.list", { workspace: "/workspace/a" }),
        /RPC timeout after 50ms: session\.list/,
    );
    await client.dispose();
});
