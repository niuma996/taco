import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NoopPlanPushAdapter } from "../../src/plan/planPushAdapter.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { builtinToolCandidates } from "../../src/tools/builtinCandidates.ts";
import {
    FILE_ACCESS_TOOL_NAMES,
    fileAccessOf,
    isFsToolDenied,
    readPathsOf,
} from "../../src/tools/fileAccess.ts";
import { defaultToolsWithTasks, type TacoTool } from "../../src/tools/index.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

// Argument names that conventionally hold a filesystem path. A built-in with
// one of these at the top level of its schema is assumed to touch files.
const PATH_LIKE =
    /^(path|paths|file|files|filePath|filename|dir|directory|input|inputs|output|outputDir|target|src|dest)$/i;

async function allBuiltinTools(): Promise<TacoTool[]> {
    const resident = defaultToolsWithTasks(
        createTaskStore("test-session"),
        "/tmp/fake-tasks",
        { active: false, currentSlug: null },
        "/tmp/fake-project",
        testTaskPublisher(),
        new NoopPlanPushAdapter(),
        TEST_SESSION_ID,
    );
    // The production list; a local scope registers a superset of an IM one.
    const candidates = builtinToolCandidates("local");
    const deferred = await Promise.all(candidates.map((c) => c.load()));
    return [...resident, ...deferred];
}

function schemaKeys(tool: TacoTool): string[] {
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    return Object.keys(props ?? {});
}

describe("built-in file access declarations", () => {
    it("every built-in with a path-like argument is declared", async () => {
        // shell takes paths inside a command string; it is fenced separately.
        const exempt = new Set(["shell"]);
        for (const tool of await allBuiltinTools()) {
            if (exempt.has(tool.name)) continue;
            const pathKeys = schemaKeys(tool).filter((k) => PATH_LIKE.test(k));
            if (pathKeys.length === 0) continue;
            const access = fileAccessOf(tool.name);
            assert.ok(
                access,
                `${tool.name} takes ${pathKeys.join(", ")} but is not in tools/fileAccess.ts`,
            );
            const declared = new Set([
                ...(access.reads ?? []).map((r) => r.key),
                ...(access.write ? [access.write] : []),
            ]);
            for (const key of pathKeys) {
                assert.ok(
                    declared.has(key),
                    `${tool.name}.${key} is not declared as a read or write`,
                );
            }
        }
    });

    it("every declared tool exists and every declared key is in its schema", async () => {
        const byName = new Map((await allBuiltinTools()).map((t) => [t.name, t]));
        for (const name of FILE_ACCESS_TOOL_NAMES) {
            const tool = byName.get(name);
            assert.ok(tool, `${name} is declared but not registered`);
            const keys = new Set(schemaKeys(tool));
            const access = fileAccessOf(name);
            for (const read of access?.reads ?? []) {
                assert.ok(
                    keys.has(read.key),
                    `${name} declares read ${read.key}, not in its schema`,
                );
            }
            if (access?.write) {
                assert.ok(
                    keys.has(access.write),
                    `${name} declares write ${access.write}, not in its schema`,
                );
            }
        }
    });

    it("a declared file tool never claims to be read-only while it writes", async () => {
        for (const tool of await allBuiltinTools()) {
            if (fileAccessOf(tool.name)?.write) {
                assert.notEqual(
                    tool.taco?.mutates,
                    false,
                    `${tool.name} writes but says mutates: false`,
                );
            }
        }
    });

    it("resolves read paths per the declared arguments", () => {
        assert.deepEqual(readPathsOf("read", { path: "a.txt" }), ["a.txt"]);
        assert.deepEqual(readPathsOf("grep", { pattern: "x" }), []);
        assert.deepEqual(readPathsOf("pdfMerge", { inputs: ["a.pdf", "", 3, "b.pdf"] }), [
            "a.pdf",
            "b.pdf",
        ]);
        assert.deepEqual(readPathsOf("pdfMerge", { inputs: "a.pdf" }), []);
        assert.deepEqual(readPathsOf("pdfFill", { input: "f.pdf", output: "o.pdf" }), ["f.pdf"]);
        assert.equal(readPathsOf("write", { path: "a" }), undefined);
        assert.equal(readPathsOf("shell", { command: "cat x" }), undefined);
        // Prototype keys are not tool names.
        assert.equal(fileAccessOf("constructor"), undefined);
        assert.equal(readPathsOf("toString", { path: "x" }), undefined);
    });
});

describe("isFsToolDenied", () => {
    it("denies exactly built-in file tools under a deny verdict", () => {
        // A deny verdict denies only names the table knows.
        assert.equal(isFsToolDenied("read", true), true);
        assert.equal(isFsToolDenied("pdfMerge", true), true);
        // Non-fs built-ins are never denied by the fs verdict.
        assert.equal(isFsToolDenied("configGet", true), false);
        assert.equal(isFsToolDenied("addTools", true), false);
        // Names outside the table (MCP / extension tools) are not this
        // judgment's to deny — matching filterToolsForImPolicy's boundary.
        assert.equal(isFsToolDenied("mcp__srv__read_file", true), false);
        // Any other verdict denies nothing (non-IM sessions pass undefined).
        assert.equal(isFsToolDenied("read", false), false);
        assert.equal(isFsToolDenied("read", undefined), false);
        // Prototype keys are not tool names.
        assert.equal(isFsToolDenied("constructor", true), false);
    });
});
