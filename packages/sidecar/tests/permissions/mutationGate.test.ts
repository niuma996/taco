import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createMutationGateHook } from "../../src/permissions/mutationGate.ts";
import { createPlanModeState, enterPlanMode } from "../../src/plan/planModeState.ts";

describe("mutation gate", () => {
    let root: string;
    let outside: string;
    let planState: ReturnType<typeof createPlanModeState>;
    let gate: ReturnType<typeof createMutationGateHook>;

    // Stand-in for the production wiring's live toolset lookup: built-in
    // read-only tools declare `taco.mutates === false`; everything else
    // (MCP / extension tools) is unknown and therefore fenced.
    const isKnownReadOnly = (toolName: string): boolean =>
        ["read", "grep", "glob", "askUser", "todoWrite"].includes(toolName);

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), "taco-gate-"));
        root = join(base, "workspace");
        outside = join(base, "outside");
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });
        planState = createPlanModeState();
        gate = createMutationGateHook({ root, getPlanState: () => planState, isKnownReadOnly });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    describe("workspace containment", () => {
        it("allows a write inside the root", async () => {
            const result = await gate({ toolName: "write", input: { path: "src/a.ts" } });
            assert.equal(result, undefined);
        });

        it("blocks a write that traverses out", async () => {
            const result = await gate({ toolName: "write", input: { path: "../outside/a.ts" } });
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /outside the workspace root/);
        });

        it("blocks an absolute write outside the root", async () => {
            const result = await gate({
                toolName: "edit",
                input: { path: join(outside, "a.ts") },
            });
            assert.equal(result?.block, true);
        });

        it("blocks a write through an escaping symlink", async () => {
            symlinkSync(outside, join(root, "escape"), "dir");
            const result = await gate({ toolName: "write", input: { path: "escape/a.ts" } });
            assert.equal(result?.block, true);
        });

        it("blocks a mutating call with a non-string path", async () => {
            const result = await gate({ toolName: "write", input: { path: 42 } });
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /requires a string "path"/);
        });

        it("ignores non-mutating tools", async () => {
            for (const toolName of ["read", "grep", "glob", "askUser", "todoWrite"]) {
                const result = await gate({ toolName, input: { path: "../outside/a.ts" } });
                assert.equal(result, undefined, `${toolName} should not be gated`);
            }
        });
    });

    describe("plan mode", () => {
        beforeEach(() => {
            enterPlanMode(planState, "2026-08-09-abc123");
        });

        it("blocks a project-file write", async () => {
            const result = await gate({ toolName: "write", input: { path: "src/a.ts" } });
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /plan mode is read-only/);
        });

        it("blocks an edit to an existing project file", async () => {
            const result = await gate({ toolName: "edit", input: { path: "src/a.ts" } });
            assert.equal(result?.block, true);
        });

        it("allows writing the plan document", async () => {
            const result = await gate({
                toolName: "write",
                input: { path: ".taco/plans/2026-08-09-abc123.md" },
            });
            assert.equal(result, undefined);
        });

        it("still enforces containment for plan-dir paths", async () => {
            const result = await gate({
                toolName: "write",
                input: { path: "../outside/plan.md" },
            });
            assert.equal(result?.block, true);
        });

        it("allows a read-only shell command", async () => {
            const result = await gate({ toolName: "shell", input: { command: "git status" } });
            assert.equal(result, undefined);
        });

        it("blocks a mutating shell command", async () => {
            const result = await gate({ toolName: "shell", input: { command: "rm -rf src" } });
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /plan mode is read-only/);
        });

        it("blocks shell redirection that would write a file", async () => {
            const result = await gate({
                toolName: "shell",
                input: { command: "echo hi > src/a.ts" },
            });
            assert.equal(result?.block, true);
        });
    });

    describe("outside plan mode", () => {
        it("does not gate shell at all", async () => {
            const result = await gate({ toolName: "shell", input: { command: "rm -rf build" } });
            assert.equal(result, undefined);
        });

        it("allows writes to project files", async () => {
            const result = await gate({ toolName: "write", input: { path: "src/a.ts" } });
            assert.equal(result, undefined);
        });
    });

    describe("snapshot fallback", () => {
        // Regression: a failing captureBeforeWrite must not block the write
        // itself, otherwise a transient I/O error freezes the user's edit.
        it("allows the write when the snapshot fails", async () => {
            const snapshotFailures: Array<{ path: string; reason: string }> = [];
            const local = createMutationGateHook({
                root,
                getPlanState: () => planState,
                captureBeforeWrite: async () => ({ ok: false, reason: "disk full" }),
                onSnapshotFailure: (path, reason) => snapshotFailures.push({ path, reason }),
            });
            const result = await local({
                toolName: "write",
                input: { path: "src/a.ts" },
            });
            assert.equal(result, undefined);
            assert.equal(snapshotFailures.length, 1);
            assert.match(snapshotFailures[0].reason, /disk full/);
        });
    });

    describe("unknown tool path fence", () => {
        it("blocks an absolute path outside the root on any path-like key", async () => {
            for (const key of ["path", "file_path", "filepath", "filename", "file", "target"]) {
                const result = await gate({
                    toolName: "mcp__fs__write_file",
                    input: { [key]: join(outside, "a.ts") },
                });
                assert.equal(result?.block, true, `key ${key} should be fenced`);
                assert.match(result?.reason ?? "", /absolute path outside the workspace root/);
            }
        });

        it("blocks an absolute path that escapes through a symlinked ancestor", async () => {
            symlinkSync(outside, join(root, "escape"), "dir");
            const result = await gate({
                toolName: "mcp__fs__write_file",
                input: { path: join(root, "escape", "a.ts") },
            });
            assert.equal(result?.block, true);
        });

        it("allows an absolute path inside the root", async () => {
            const result = await gate({
                toolName: "mcp__fs__write_file",
                input: { path: join(root, "src/a.ts") },
            });
            assert.equal(result, undefined);
        });

        // Relative values are out of scope by design: the gate does not know
        // which directory an unknown tool resolves them against, so refusing
        // them would reject legitimate non-path arguments while proving
        // nothing about where the tool would actually write.
        it("allows relative values, including traversal and non-path strings", async () => {
            for (const value of [
                "src/a.ts",
                "../outside/a.ts",
                "../v2/endpoint",
                "release/1.2",
                "",
            ]) {
                const result = await gate({
                    toolName: "mcp__http__request",
                    input: { target: value },
                });
                assert.equal(result, undefined, `value ${JSON.stringify(value)} should pass`);
            }
        });

        it("allows URL-shaped values", async () => {
            for (const value of [
                "https://api.example.com/v1/models",
                "file:///etc/passwd",
                "s3://bucket/key",
            ]) {
                const result = await gate({
                    toolName: "mcp__http__request",
                    input: { path: value },
                });
                assert.equal(result, undefined, `value ${JSON.stringify(value)} should pass`);
            }
        });

        it("ignores non-string values", async () => {
            const result = await gate({
                toolName: "mcp__fs__write_file",
                input: { path: 42 },
            });
            assert.equal(result, undefined);
        });

        it("exempts tools the predicate reports as read-only", async () => {
            const result = await gate({ toolName: "read", input: { path: join(outside, "a.ts") } });
            assert.equal(result, undefined);
        });

        it("fences every unknown tool when no predicate is supplied", async () => {
            const local = createMutationGateHook({ root, getPlanState: () => planState });
            const result = await local({
                toolName: "read",
                input: { path: join(outside, "a.ts") },
            });
            assert.equal(result?.block, true);
        });
    });
});
