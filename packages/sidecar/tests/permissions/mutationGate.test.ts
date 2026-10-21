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

        // Regression: pi's write/edit expand `~/`, strip a leading `@` and
        // decode `file://` before writing. The gate used to check the raw
        // string, so all of these resolved "inside" the root and were allowed
        // while the tool wrote to $HOME or /etc.
        it("blocks ~, @ and file:// paths that pi resolves outside the root", async () => {
            for (const path of [
                "~",
                "~/.taco/taco.json",
                "~/.zshrc",
                `@${join(outside, "a.ts")}`,
                `file://${join(outside, "a.ts")}`,
            ]) {
                for (const toolName of ["write", "edit"]) {
                    const result = await gate({ toolName, input: { path } });
                    assert.equal(result?.block, true, `${toolName} ${path} must be blocked`);
                }
            }
        });

        it("still allows @ and file:// paths that pi resolves inside the root", async () => {
            for (const path of [
                `@${join(root, "a.ts")}`,
                `file://${join(root, "a.ts")}`,
                "@src/a.ts",
            ]) {
                const result = await gate({ toolName: "write", input: { path } });
                assert.equal(result, undefined, `${path} should be allowed`);
            }
        });

        describe("extra write roots", () => {
            let extra: string;
            let withExtra: ReturnType<typeof createMutationGateHook>;
            beforeEach(() => {
                extra = join(outside, "skills");
                mkdirSync(extra, { recursive: true });
                withExtra = createMutationGateHook({
                    root,
                    getPlanState: () => planState,
                    isKnownReadOnly,
                    extraWriteRoots: [extra],
                });
            });

            it("allows an absolute write or edit inside an extra root", async () => {
                for (const toolName of ["write", "edit"]) {
                    const result = await withExtra({
                        toolName,
                        input: { path: join(extra, "my-skill", "SKILL.md") },
                    });
                    assert.equal(result, undefined, `${toolName} should be allowed`);
                }
            });

            it("still blocks a sibling of the extra root", async () => {
                const result = await withExtra({
                    toolName: "write",
                    input: { path: join(outside, "taco.json") },
                });
                assert.equal(result?.block, true);
            });

            it("resolves relative paths against the workspace, never the extra root", async () => {
                // A bare name is a workspace path; it must not be re-anchored
                // onto the extra root and must not be blocked.
                const bare = await withExtra({ toolName: "write", input: { path: "SKILL.md" } });
                assert.equal(bare, undefined);
                // A traversal that lands outside both roots stays blocked.
                const traversal = await withExtra({
                    toolName: "write",
                    input: { path: "../outside/elsewhere.txt" },
                });
                assert.equal(traversal?.block, true);
            });

            it("blocks a write that escapes the extra root through a symlink", async () => {
                const elsewhere = join(outside, "nested");
                mkdirSync(elsewhere, { recursive: true });
                symlinkSync(elsewhere, join(extra, "out"), "dir");
                const result = await withExtra({
                    toolName: "write",
                    input: { path: join(extra, "out", "a.txt") },
                });
                assert.equal(result?.block, true);
            });

            it("refuses extra roots in plan mode", async () => {
                enterPlanMode(planState, "plan");
                const result = await withExtra({
                    toolName: "write",
                    input: { path: join(extra, "SKILL.md") },
                });
                assert.equal(result?.block, true);
            });

            it("does not widen the unknown-tool fence", async () => {
                const result = await withExtra({
                    toolName: "mcp__fs__write_file",
                    input: { path: join(extra, "SKILL.md") },
                });
                assert.equal(result?.block, true);
            });
        });

        describe("associated directories", () => {
            let associated: string;
            let withAssociated: ReturnType<typeof createMutationGateHook>;
            beforeEach(() => {
                associated = join(outside, "project");
                mkdirSync(associated, { recursive: true });
                withAssociated = createMutationGateHook({
                    root,
                    getPlanState: () => planState,
                    isKnownReadOnly,
                    getAssociatedRoots: () => [associated],
                });
            });

            it("allows an absolute write or edit inside an associated root", async () => {
                for (const toolName of ["write", "edit"]) {
                    const result = await withAssociated({
                        toolName,
                        input: { path: join(associated, "a.ts") },
                    });
                    assert.equal(result, undefined, `${toolName} should be allowed`);
                }
            });

            it("still blocks a path that is in neither root", async () => {
                const result = await withAssociated({
                    toolName: "write",
                    input: { path: join(outside, "elsewhere.ts") },
                });
                assert.equal(result?.block, true);
                assert.match(result?.reason ?? "", /associated directories/);
            });

            it("resolves relative paths against the workspace, never the associated root", async () => {
                const result = await withAssociated({
                    toolName: "write",
                    input: { path: "notes.md" },
                });
                assert.equal(result, undefined);
            });

            it("blocks a write that escapes the associated root through a symlink", async () => {
                const elsewhere = join(outside, "nested");
                mkdirSync(elsewhere, { recursive: true });
                symlinkSync(elsewhere, join(associated, "out"), "dir");
                const result = await withAssociated({
                    toolName: "write",
                    input: { path: join(associated, "out", "a.txt") },
                });
                assert.equal(result?.block, true);
            });

            it("refuses associated directories in plan mode", async () => {
                enterPlanMode(planState, "plan");
                const result = await withAssociated({
                    toolName: "write",
                    input: { path: join(associated, "a.ts") },
                });
                assert.equal(result?.block, true);
            });

            it("does not widen the unknown-tool fence", async () => {
                const result = await withAssociated({
                    toolName: "mcp__fs__write_file",
                    input: { path: join(associated, "a.ts") },
                });
                assert.equal(result?.block, true);
            });
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

        it("fences ~ and file:// values, which name an absolute location", async () => {
            for (const value of ["~/.ssh/config", `file://${join(outside, "a.ts")}`]) {
                const result = await gate({
                    toolName: "mcp__fs__write_file",
                    input: { path: value },
                });
                assert.equal(
                    result?.block,
                    true,
                    `value ${JSON.stringify(value)} should be fenced`,
                );
            }
        });

        it("allows URL-shaped values that are not filesystem locations", async () => {
            for (const value of ["https://api.example.com/v1/models", "s3://bucket/key"]) {
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

    // An IM conversation is driven by a third party, so its reads are fenced
    // to the workspace's own directory plus the directories the user
    // associated with it. A local session's reads stay unfenced.
    describe("read fence", () => {
        let associated: string;
        let fenced: ReturnType<typeof createMutationGateHook>;

        beforeEach(() => {
            associated = join(outside, "associated");
            mkdirSync(associated, { recursive: true });
            fenced = createMutationGateHook({
                root,
                getPlanState: () => planState,
                isKnownReadOnly,
                readRoots: { primary: root, getAssociated: () => [associated] },
            });
        });

        it("allows a read inside the workspace", async () => {
            const result = await fenced({ toolName: "read", input: { path: "src/a.ts" } });
            assert.equal(result, undefined);
        });

        it("allows a read inside an associated directory", async () => {
            const result = await fenced({
                toolName: "read",
                input: { path: join(associated, "a.ts") },
            });
            assert.equal(result, undefined);
        });

        it("refuses a read outside both, and says not to retry", async () => {
            const result = await fenced({
                toolName: "read",
                input: { path: join(outside, "secret.txt") },
            });
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /no access outside/);
            assert.match(result?.reason ?? "", /Do not retry it/);
        });

        it("refuses a relative path that escapes the workspace", async () => {
            const result = await fenced({
                toolName: "read",
                input: { path: "../outside/secret.txt" },
            });
            assert.equal(result?.block, true);
        });

        it("fences grep and glob search roots too", async () => {
            for (const toolName of ["grep", "glob"]) {
                const result = await fenced({
                    toolName,
                    input: { path: outside, pattern: "x" },
                });
                assert.equal(result?.block, true, `${toolName} must be fenced`);
            }
        });

        it("leaves reads unfenced when no read roots are set", async () => {
            const result = await gate({ toolName: "read", input: { path: join(outside, "a.ts") } });
            assert.equal(result, undefined);
        });

        it("fences a read that escapes through a symlink", async () => {
            symlinkSync(outside, join(root, "escape"), "dir");
            const result = await fenced({
                toolName: "read",
                input: { path: join(root, "escape", "secret.txt") },
            });
            assert.equal(result?.block, true);
        });
    });
});
