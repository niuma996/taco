import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PushMethods, type ServerPush, WORKSPACE_ANY } from "@taco-ai/protocol";
import { WorkPushAdapter } from "../../src/server/workPushAdapter.ts";

function rig(windowMs = 1_000_000) {
    const frames: ServerPush[] = [];
    const adapter = new WorkPushAdapter((f) => {
        frames.push(f);
    }, windowMs);
    return { frames, adapter };
}

describe("server.workPushAdapter", () => {
    it("announces a change as an empty, process-level frame", () => {
        const { frames, adapter } = rig();
        adapter.changed();
        adapter.flush();
        assert.equal(frames.length, 1);
        const frame = frames[0];
        assert.equal(frame?.method, PushMethods.WorkChanged);
        assert.equal(frame?.workspace, WORKSPACE_ANY);
        assert.equal(frame?.session, undefined);
        assert.equal(frame?.seq, undefined, "never enters a session's replay sequence");
        assert.deepEqual(frame?.params, {});
        adapter.close();
    });

    it("folds a burst of changes into one frame", () => {
        const { frames, adapter } = rig();
        for (let i = 0; i < 450; i++) adapter.changed();
        adapter.flush();
        assert.equal(frames.length, 1);
        adapter.close();
    });

    it("sends nothing when nothing changed", () => {
        const { frames, adapter } = rig();
        adapter.flush();
        assert.equal(frames.length, 0);
        adapter.close();
    });

    it("sends on its own once the window closes", async () => {
        const { frames, adapter } = rig(5);
        adapter.changed();
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(frames.length, 1);
        adapter.close();
    });

    it("survives a transport that throws or rejects, and keeps reporting later changes", async () => {
        const frames: ServerPush[] = [];
        let calls = 0;
        const adapter = new WorkPushAdapter((f) => {
            calls++;
            if (calls === 1) throw new Error("sink closed");
            if (calls === 2) return Promise.reject(new Error("write failed"));
            frames.push(f);
        });
        adapter.changed();
        adapter.flush();
        adapter.changed();
        adapter.flush();
        adapter.changed();
        adapter.flush();
        // Let the rejected promise's catch run.
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(frames.length, 1, "the third announcement still went out");
        adapter.close();
    });

    it("close drops what was waiting and ignores later changes", async () => {
        const { frames, adapter } = rig(5);
        adapter.changed();
        adapter.close();
        adapter.changed();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(frames.length, 0);
    });
});
