import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameDispatcher } from "../dispatcher.js";

test("rejectWorkspacePending rejects only the disconnected workspace", async () => {
    const dispatcher = new FrameDispatcher();
    const first = dispatcher.registerPending("first", "/workspace/a");
    const second = dispatcher.registerPending("second", "/workspace/b");

    dispatcher.rejectWorkspacePending("/workspace/a", new Error("sidecar exited"));
    dispatcher.handleFrame({ id: "second", ok: true, result: "ok" });

    await assert.rejects(first, /sidecar exited/);
    assert.equal(await second, "ok");
});

test("preserves the session sequence on a push frame", () => {
    const dispatcher = new FrameDispatcher();
    let received: unknown;
    dispatcher.onPush((push) => {
        received = push;
    });

    dispatcher.handleFrame({
        method: "session.attached",
        workspace: "/workspace",
        session: "session",
        seq: 7,
        params: {},
    });

    assert.deepEqual(received, {
        method: "session.attached",
        workspace: "/workspace",
        session: "session",
        seq: 7,
        params: {},
        id: undefined,
        sessionKind: undefined,
    });
});
