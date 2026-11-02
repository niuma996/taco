import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { SlashNormalizedExecutionEnv } from "../../src/runtime/harness/slashNormalizedEnv.ts";

describe("SlashNormalizedExecutionEnv.listDir", () => {
    it("ignores an entry renamed away between readdir and lstat", async () => {
        const dir = mkdtempSync(join(tmpdir(), "taco-list-race-"));
        const tmp = join(dir, "session.jsonl.tmp");
        const final = join(dir, "session.jsonl");
        const env = new SlashNormalizedExecutionEnv({ cwd: dir });
        let writing = true;
        let writes = 0;
        const writer = (async () => {
            while (writing && writes < 500) {
                await writeFile(tmp, "{}\n");
                await rename(tmp, final);
                await unlink(final);
                writes++;
            }
        })();
        try {
            for (let i = 0; i < 200; i++) {
                const result = await env.listDir(dir, harnessContext);
                assert.equal(result.ok, true, result.ok ? "" : result.error.message);
            }
        } finally {
            writing = false;
            await writer;
            rmSync(dir, { recursive: true, force: true });
        }
        assert.ok(writes > 0, "the rename loop actually ran");
    });
});
