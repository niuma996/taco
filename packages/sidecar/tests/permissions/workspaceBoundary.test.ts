import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    normalizeBuiltinToolPath,
    resolveWithinRoot,
    resolveWithinRootSet,
} from "../../src/permissions/workspaceBoundary.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createWriteTool } from "../../src/runtime/pi/values.ts";

describe("resolveWithinRoot", () => {
    let root: string;
    let outside: string;

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), "taco-boundary-"));
        root = join(base, "workspace");
        outside = join(base, "outside");
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    it("allows a relative path inside the root", async () => {
        const result = await resolveWithinRoot(root, "src/index.ts");
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.absolutePath, join(root, "src/index.ts"));
    });

    it("allows a not-yet-created nested path", async () => {
        const result = await resolveWithinRoot(root, "a/b/c/new.ts");
        assert.equal(result.ok, true);
    });

    it("rejects traversal above the root", async () => {
        const result = await resolveWithinRoot(root, "../outside/x.ts");
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /outside the workspace root/);
    });

    it("rejects an absolute path outside the root", async () => {
        const result = await resolveWithinRoot(root, join(outside, "x.ts"));
        assert.equal(result.ok, false);
    });

    it("rejects an empty path", async () => {
        const result = await resolveWithinRoot(root, "   ");
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /must not be empty/);
    });

    // Lexical checks pass here — only realpath resolution catches it.
    it("rejects a write through a symlinked directory pointing outside", async () => {
        symlinkSync(outside, join(root, "escape"), "dir");
        const result = await resolveWithinRoot(root, "escape/x.ts");
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /outside the workspace root/);
    });

    it("rejects an existing symlinked file pointing outside", async () => {
        const target = join(outside, "secret.txt");
        writeFileSync(target, "s");
        symlinkSync(target, join(root, "link.txt"));
        const result = await resolveWithinRoot(root, "link.txt");
        assert.equal(result.ok, false);
    });

    it("treats the root itself as contained", async () => {
        const result = await resolveWithinRoot(root, ".");
        assert.equal(result.ok, true);
    });

    // Regression: a root that is itself a symlink must still compare against
    // its resolved target, not the symlink path. Otherwise a workspace whose
    // real location differs from the input string leaks containment.
    it("resolves a symlinked root before containment", async () => {
        const realRoot = join(root, "..", "real-workspace");
        mkdirSync(realRoot, { recursive: true });
        writeFileSync(join(realRoot, "inside.txt"), "ok");
        const linkedRoot = join(root, "link");
        symlinkSync(realRoot, linkedRoot);

        const result = await resolveWithinRoot(linkedRoot, "inside.txt");
        assert.equal(result.ok, true);
        // `absolutePath` stays lexical — containment is what compares to the
        // realpath of the symlinked root.
        if (result.ok) assert.equal(result.absolutePath, join(linkedRoot, "inside.txt"));
    });

    it("rejects a path that escapes through a symlinked root", async () => {
        const realRoot = join(root, "..", "real-workspace");
        mkdirSync(realRoot, { recursive: true });
        const linkedRoot = join(root, "link");
        symlinkSync(realRoot, linkedRoot);

        // The real target sits next to realRoot, not inside it.
        const sibling = join(realRoot, "..", "outside.txt");
        writeFileSync(sibling, "nope");
        const result = await resolveWithinRoot(linkedRoot, join("..", "outside.txt"));
        assert.equal(result.ok, false);
    });
});

describe("resolveWithinRootSet", () => {
    let root: string;
    let associated: string;
    let outside: string;

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), "taco-rootset-"));
        root = join(base, "workspace");
        associated = join(base, "associated");
        outside = join(base, "outside");
        mkdirSync(root, { recursive: true });
        mkdirSync(associated, { recursive: true });
        mkdirSync(outside, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(associated, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    it("allows a path inside the primary root", async () => {
        const result = await resolveWithinRootSet(root, [associated], "src/index.ts");
        assert.equal(result.ok, true);
    });

    it("allows an absolute path inside an associated root", async () => {
        const result = await resolveWithinRootSet(root, [associated], join(associated, "a.ts"));
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.absolutePath, join(associated, "a.ts"));
    });

    it("rejects a path that is in neither root", async () => {
        const result = await resolveWithinRootSet(root, [associated], join(outside, "a.ts"));
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /associated directories/);
    });

    it("does not re-anchor a relative path onto an associated root", async () => {
        // "notes.md" means the workspace's own notes.md. It must not resolve
        // to associated/notes.md just because the directory is associated.
        const result = await resolveWithinRootSet(root, [associated], "notes.md");
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.absolutePath, join(root, "notes.md"));
    });

    it("allows a relative traversal that lands inside an associated root", async () => {
        // The path still resolves against the primary root; the associated
        // root only decides whether the result is permitted.
        const result = await resolveWithinRootSet(root, [associated], "../associated/a.ts");
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.absolutePath, join(associated, "a.ts"));
    });

    it("rejects a path that escapes an associated root through a symlink", async () => {
        symlinkSync(outside, join(associated, "escape"), "dir");
        const result = await resolveWithinRootSet(
            root,
            [associated],
            join(associated, "escape", "a.ts"),
        );
        assert.equal(result.ok, false);
    });

    it("rejects an empty path", async () => {
        const result = await resolveWithinRootSet(root, [associated], "  ");
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /must not be empty/);
    });

    it("keeps the plain reason when no associated root is given", async () => {
        const result = await resolveWithinRootSet(root, [], join(outside, "a.ts"));
        assert.equal(result.ok, false);
        if (!result.ok) assert.doesNotMatch(result.reason, /associated directories/);
    });
});

// The gate checks the path pi's built-in write/edit will actually touch, so its
// normalisation must not drift from pi's. Drive pi's real `write` tool with an
// env whose path resolution is pi's own (NodeExecutionEnv) but whose writeFile
// only records the target — a pi upgrade that changes the rules fails here.
describe("normalizeBuiltinToolPath matches pi's write tool", () => {
    const cwd = mkdtempSync(join(tmpdir(), "taco-parity-"));
    const real = new NodeExecutionEnv({ cwd });

    async function piWriteTarget(rawPath: string): Promise<string> {
        let target = "";
        const env = new Proxy(real, {
            get(obj, key, receiver) {
                if (key === "writeFile") {
                    return async (path: string) => {
                        target = path;
                        return { ok: true, value: undefined };
                    };
                }
                const value = Reflect.get(obj, key, receiver);
                return typeof value === "function" ? value.bind(obj) : value;
            },
        });
        const tool = createWriteTool();
        await tool.execute(
            "t",
            { path: rawPath, content: "" },
            () => undefined,
            { env } as never,
            undefined as never,
            { abortSignal: undefined } as never,
        );
        return target;
    }

    for (const raw of [
        "src/a.ts",
        "../escape.ts",
        "/etc/hosts",
        "~",
        "~/.taco/taco.json",
        "@src/a.ts",
        "@/etc/hosts",
        "@~/x.ts",
        "file:///etc/hosts",
        "file://%zz",
        "with\u00A0nbsp.ts",
    ]) {
        it(`agrees on ${JSON.stringify(raw)}`, async () => {
            assert.equal(resolve(cwd, normalizeBuiltinToolPath(raw)), await piWriteTarget(raw));
        });
    }
});
