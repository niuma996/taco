import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SidecarEpochs } from "../../src/lib/sidecarEpoch.ts";

describe("SidecarEpochs", () => {
    it("marks a changed instance id for one workspace as a replacement", () => {
        const epochs = new SidecarEpochs();
        assert.equal(epochs.observe("/workspace/a", "one"), "new");
        assert.equal(epochs.observe("/workspace/a", "one"), "unchanged");
        assert.equal(epochs.observe("/workspace/a", "two"), "replaced");
        assert.equal(epochs.observe("/workspace/b", "one"), "new");
    });
});
