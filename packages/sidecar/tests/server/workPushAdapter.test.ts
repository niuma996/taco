import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PushMethods, type ServerPush, WORKSPACE_ANY } from "@taco-ai/protocol";
import { WorkPushAdapter } from "../../src/server/workPushAdapter.ts";

function rig(windowMs = 1_000_000) {
    const frames: ServerPush[] = [];
    const adapter = new WorkPushAdapter("inst-1", (f) => frames.push(f), windowMs);
    return { frames, adapter };
}

describe("server.workPushAdapter", () => {
    it("announces a change as a process-level frame with no session and no answer text", () => {
        const { frames, adapter } = rig();
        adapter.changed("w-1");
        adapter.flush();
        assert.equal(frames.length, 1);
        const frame = frames[0];
        assert.equal(frame?.method, PushMethods.WorkChanged);
        assert.equal(frame?.workspace, WORKSPACE_ANY);
        assert.equal(frame?.session, undefined);
        assert.equal(frame?.seq, undefined, "never enters a session's replay sequence");
        assert.deepEqual(frame?.params, { instanceId: "inst-1", workIds: ["w-1"] });
        adapter.close();
    });

    it("folds a burst of changes into one frame and names each Work once", () => {
        const { frames, adapter } = rig();
        for (const id of ["w-1", "w-2", "w-1", "w-3", "w-2"]) adapter.changed(id);
        adapter.flush();
        assert.equal(frames.length, 1);
        assert.deepEqual((frames[0]?.params as { workIds: string[] }).workIds, [
            "w-1",
            "w-2",
            "w-3",
        ]);
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
        adapter.changed("w-1");
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(frames.length, 1);
        adapter.close();
    });

    it("splits an extreme burst across frames instead of one huge one", () => {
        const { frames, adapter } = rig();
        for (let i = 0; i < 450; i++) adapter.changed(`w-${i}`);
        adapter.flush();
        assert.equal(frames.length, 3);
        const ids = frames.flatMap((f) => (f.params as { workIds: string[] }).workIds);
        assert.equal(new Set(ids).size, 450);
        adapter.close();
    });

    it("close drops what was waiting and ignores later changes", async () => {
        const { frames, adapter } = rig(5);
        adapter.changed("w-1");
        adapter.close();
        adapter.changed("w-2");
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(frames.length, 0);
    });
});
