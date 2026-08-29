import assert from "node:assert/strict";
import { test } from "node:test";
import { createToastManager } from "../../src/hooks/primitives/useToast.ts";

test("show displays a toast", () => {
    const m = createToastManager();
    m.show("hello");
    assert.equal(m.state()?.message, "hello");
    assert.equal(m.state()?.level, "info");
});

test("show with warn level", () => {
    const m = createToastManager();
    m.show("careful", "warn");
    assert.equal(m.state()?.level, "warn");
});

test("latter show overrides earlier", () => {
    const m = createToastManager();
    m.show("first");
    m.show("second");
    assert.equal(m.state()?.message, "second");
});

test("dismiss clears immediately", () => {
    const m = createToastManager();
    m.show("hi");
    m.dismiss();
    assert.equal(m.state(), null);
});

test("dismiss is a no-op when no toast active", () => {
    const m = createToastManager();
    m.dismiss();
    assert.equal(m.state(), null);
});

test("auto-dismiss after timeout", async () => {
    const m = createToastManager({ defaultDurationMs: 30 });
    m.show("hi");
    assert.equal(m.state()?.message, "hi");
    await new Promise<void>((resolve) => {
        setTimeout(() => {
            assert.equal(m.state(), null);
            resolve();
        }, 60);
    });
});

test("subscribe receives notifications", () => {
    const m = createToastManager();
    let count = 0;
    const unsub = m.subscribe(() => {
        count++;
    });
    m.show("first");
    m.show("second");
    m.dismiss();
    unsub();
    m.show("after unsub");
    assert.equal(count, 3, "subscriber should be called for show/show/dismiss but not after unsub");
});

test("subscribe cleanup stops notifications", () => {
    const m = createToastManager();
    let count = 0;
    const unsub = m.subscribe(() => {
        count++;
    });
    m.show("a");
    unsub();
    m.show("b");
    assert.equal(count, 1);
});
