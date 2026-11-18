import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enqueueCheckpointIndexWrite } from "../../src/checkpoints/writeCoordinator.ts";

test("serializes aliases that resolve to the same checkpoint index", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-checkpoint-coordinator-"));
    try {
        const real = join(root, "real");
        const alias = join(root, "alias");
        await mkdir(real);
        await symlink(real, alias, "dir");

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let firstStarted = false;
        let secondStarted = false;
        const first = enqueueCheckpointIndexWrite(join(real, "index.json"), async () => {
            firstStarted = true;
            await gate;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const second = enqueueCheckpointIndexWrite(join(alias, "index.json"), async () => {
            secondStarted = true;
        });

        assert.equal(firstStarted, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(secondStarted, false);
        release();
        await Promise.all([first, second]);
        assert.equal(secondStarted, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
