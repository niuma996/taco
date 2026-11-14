import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { SubagentRunLifecycle } from "../../src/runtime/subagent/subagentRunLifecycle.ts";

const parent = asSessionId("parent");
const otherParent = asSessionId("other");

test("nested scopes retain one controller until the outer settle finishes", async () => {
    const lifecycle = new SubagentRunLifecycle();
    const outer = lifecycle.acquire({ sessionId: "child", parentSessionId: parent });
    await lifecycle.run(
        { sessionId: "child", parentSessionId: parent, controller: outer.controller },
        async (controller) => {
            assert.equal(controller, outer.controller);
        },
    );
    assert.equal(lifecycle.abort("child", otherParent), false);
    assert.equal(lifecycle.abort("child", parent), true);
    outer.release();
    assert.equal(lifecycle.abort("child", parent), false);
});

test("a scope always removes its external abort listener after failure", async () => {
    const lifecycle = new SubagentRunLifecycle();
    const external = new AbortController();
    await assert.rejects(
        lifecycle.run(
            { sessionId: "child", parentSessionId: parent, signal: external.signal },
            async () => {
                assert.equal(getEventListeners(external.signal, "abort").length, 1);
                throw new Error("setup failed");
            },
        ),
        /setup failed/,
    );
    assert.equal(getEventListeners(external.signal, "abort").length, 0);
    assert.equal(lifecycle.abort("child"), false);
});

test("pre-abort and later abort preserve the original reason", () => {
    const lifecycle = new SubagentRunLifecycle();
    for (const alreadyAborted of [true, false]) {
        const external = new AbortController();
        const reason = { kind: "subagent-timeout", timeoutMinutes: 10 };
        if (alreadyAborted) external.abort(reason);
        const scope = lifecycle.acquire({
            sessionId: "child",
            parentSessionId: parent,
            signal: external.signal,
        });
        if (!alreadyAborted) external.abort(reason);
        assert.equal(scope.controller.signal.aborted, true);
        assert.equal(scope.controller.signal.reason, reason);
        scope.release();
    }
});

test("old cleanup cannot delete a replacement controller", () => {
    const controllers = new Map();
    const lifecycle = new SubagentRunLifecycle(controllers);
    const first = lifecycle.acquire({ sessionId: "child", parentSessionId: parent });
    const replacement = new AbortController();
    controllers.set("child", { controller: replacement, parentSessionId: parent });
    first.release();
    assert.equal(lifecycle.abort("child", parent), true);
    assert.equal(replacement.signal.aborted, true);
});

test("another execution cannot replace an admitted controller or borrow another parent's scope", () => {
    const lifecycle = new SubagentRunLifecycle();
    const scope = lifecycle.acquire({ sessionId: "child", parentSessionId: parent });
    assert.throws(
        () => lifecycle.acquire({ sessionId: "child", parentSessionId: parent }),
        /already running/,
    );
    assert.throws(
        () =>
            lifecycle.acquire({
                sessionId: "child",
                parentSessionId: otherParent,
                controller: scope.controller,
            }),
        /already running/,
    );
    scope.release();
});

test("stopChildrenOf waits for final scope release and leaves other parents alone", async () => {
    const lifecycle = new SubagentRunLifecycle();
    const child = lifecycle.acquire({ sessionId: "child", parentSessionId: parent });
    const other = lifecycle.acquire({ sessionId: "other", parentSessionId: otherParent });
    const stopped = lifecycle.stopChildrenOf(parent, 1000);
    assert.equal(child.controller.signal.aborted, true);
    assert.equal(other.controller.signal.aborted, false);
    child.release();
    assert.deepEqual(await stopped, []);
    other.release();
});

test("stop timeout removes its waiter and allows a later clean stop", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const lifecycle = new SubagentRunLifecycle();
    const scope = lifecycle.acquire({ sessionId: "child", parentSessionId: parent });
    const stopped = lifecycle.stopChildrenOf(parent, 100);
    t.mock.timers.tick(100);
    assert.deepEqual(await stopped, ["child"]);
    scope.release();
    assert.deepEqual(await lifecycle.stopChildrenOf(parent), []);
});

test("shutdown aborts active and subsequently admitted scopes", () => {
    const lifecycle = new SubagentRunLifecycle();
    const first = lifecycle.acquire({ sessionId: "first", parentSessionId: parent });
    lifecycle.stop();
    assert.equal(first.controller.signal.aborted, true);
    const late = lifecycle.acquire({ sessionId: "late", parentSessionId: parent });
    assert.equal(late.controller.signal.aborted, true);
    first.release();
    late.release();
});
