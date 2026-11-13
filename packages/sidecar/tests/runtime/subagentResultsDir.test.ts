import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import {
    settledSubagentResultIds,
    subagentResultsDir,
} from "../../src/runtime/subagent/subagentResultsDir.ts";

it("discovers both legacy and run-scoped background results", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-results-"));
    const parent = asSessionId("parent-results");
    try {
        const dir = subagentResultsDir(parent, root);
        await mkdir(join(dir, "child-run-scoped"), { recursive: true });
        await writeFile(join(dir, "child-legacy.md"), "legacy");
        await writeFile(join(dir, "child-run-scoped", "run-1.md"), "run scoped");
        await mkdir(join(dir, "child-unsettled"), { recursive: true });
        assert.deepEqual((await settledSubagentResultIds(parent, root)).sort(), [
            "child-legacy",
            "child-run-scoped",
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
