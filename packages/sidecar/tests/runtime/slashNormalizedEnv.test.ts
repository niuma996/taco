import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { contextFor, harnessContext } from "../../src/lib/harnessContext.ts";
import { SlashNormalizedExecutionEnv } from "../../src/runtime/harness/slashNormalizedEnv.ts";
import {
    FileError,
    type FileInfo,
    NodeExecutionEnv,
    type Result,
} from "../../src/runtime/pi/node.ts";

describe("SlashNormalizedExecutionEnv.listDir", () => {
    it("delegates with the original path and context, normalizing returned entries", async (t) => {
        const env = new SlashNormalizedExecutionEnv({ cwd: process.cwd() });
        const context = contextFor(new AbortController().signal);
        const entries: FileInfo[] = [
            {
                name: "C:\\workspace\\.hidden",
                path: "C:\\workspace\\.hidden",
                kind: "file",
                size: 42,
                mtimeMs: 123,
            },
            {
                name: "C:\\workspace\\node_modules",
                path: "C:\\workspace\\node_modules",
                kind: "directory",
                size: 0,
                mtimeMs: 456,
            },
            {
                name: "link",
                path: "/workspace/link",
                kind: "symlink",
                size: 12,
                mtimeMs: 789,
            },
        ];
        const originalEntries = structuredClone(entries);
        const listDir = t.mock.method(
            NodeExecutionEnv.prototype,
            "listDir",
            async (): Promise<Result<FileInfo[], FileError>> => ({ ok: true, value: entries }),
        );

        const result = await env.listDir("relative/directory", context);

        assert.equal(listDir.mock.callCount(), 1);
        assert.deepEqual(listDir.mock.calls[0].arguments, ["relative/directory", context]);
        assert.strictEqual(listDir.mock.calls[0].arguments[1], context);
        assert.strictEqual(listDir.mock.calls[0].this, env);
        assert.deepEqual(result, {
            ok: true,
            value: [
                { ...entries[0], path: "C:/workspace/.hidden", name: ".hidden" },
                { ...entries[1], path: "C:/workspace/node_modules", name: "node_modules" },
                entries[2],
            ],
        });
        assert.deepEqual(entries, originalEntries, "upstream entries must remain unchanged");
    });

    it("preserves the upstream error result including its path and cause", async (t) => {
        const env = new SlashNormalizedExecutionEnv({ cwd: process.cwd() });
        const cause = new Error("entry access denied");
        const upstream: Result<FileInfo[], FileError> = {
            ok: false,
            error: new FileError("permission_denied", cause.message, "C:\\workspace\\entry", cause),
        };
        t.mock.method(NodeExecutionEnv.prototype, "listDir", async () => upstream);

        const result = await env.listDir("relative/directory", harnessContext);

        assert.strictEqual(result, upstream);
    });

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
