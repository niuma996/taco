/**
 * gitContext extension tests.
 *
 * Exercises the public surface of the builtin git-context extension:
 *   - tag spec shape (compression pin, hidden, xml-balanced)
 *   - context hook injects `<recent_git_commits>` tag with inline guidance
 *   - context hook returns `undefined` when cwd isn't a git repo
 *   - activator returns undefined on non-git repos
 *   - activator returns {contextHooks} on git repos
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-agent-core";
import {
    buildGitContextActivator,
    buildGitContextHook,
    getRecentGitCommitsTagSpec,
    getWorkingTreeChangesTagSpec,
    readUncommittedFiles,
} from "../../../src/extensions/builtin/gitContext/index.ts";

let gitDir: string;
let nonGitDir: string;

before(() => {
    nonGitDir = mkdtempSync(join(tmpdir(), "taco-gitctx-nongit-"));
    gitDir = mkdtempSync(join(tmpdir(), "taco-gitctx-git-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: gitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
    writeFileSync(join(gitDir, "README.md"), "hello");
    execFileSync("git", ["add", "README.md"], { cwd: gitDir });
    execFileSync("git", ["commit", "-m", "first commit"], { cwd: gitDir });
    writeFileSync(join(gitDir, "src.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "src.ts"], { cwd: gitDir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: gitDir });

    // Create uncommitted state in gitDir:
    //   - staged:   new file "staged.txt"
    //   - unstaged: modified "README.md"
    //   - untracked: new file "untracked.txt"
    writeFileSync(join(gitDir, "staged.txt"), "staged content\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: gitDir, stdio: "ignore" });
    writeFileSync(join(gitDir, "README.md"), "modified\n");
    writeFileSync(join(gitDir, "untracked.txt"), "untracked content\n");
    // leave README.md and untracked.txt unstaged / untracked
});

after(() => {
    if (nonGitDir) rmSync(nonGitDir, { recursive: true, force: true });
    if (gitDir) rmSync(gitDir, { recursive: true, force: true });
});

function makeMessages() {
    return [{ role: "user" as const, content: "hello", timestamp: 0 }];
}

describe("builtin git-context extension — tag specs", () => {
    it("registers recent_git_commits as a hidden, pin-compressed, xml-balanced tag", () => {
        const spec = getRecentGitCommitsTagSpec();
        assert.equal(spec.name, "recent_git_commits");
        assert.equal(spec.scope, "user-context");
        assert.equal(spec.compression.kind, "pin");
        assert.equal(spec.tuiVisibility, "hidden");
        assert.equal(spec.parser.kind, "xml-balanced");
        assert.ok(spec.description.length > 0);
    });

    it("registers working_tree_changes as a hidden, pin-compressed, xml-balanced tag", () => {
        const spec = getWorkingTreeChangesTagSpec();
        assert.equal(spec.name, "working_tree_changes");
        assert.equal(spec.scope, "user-context");
        assert.equal(spec.compression.kind, "pin");
        assert.equal(spec.tuiVisibility, "hidden");
        assert.equal(spec.parser.kind, "xml-balanced");
        assert.ok(spec.description.length > 0);
    });
});

describe("builtin git-context extension — hook", () => {
    it("returns undefined when cwd is not a git repo", async () => {
        const hook = buildGitContextHook(nonGitDir);
        const result = await hook({ messages: makeMessages() } as ContextEvent);
        assert.equal(result, undefined);
    });

    it("injects a <recent_git_commits> tag with inline guidance when cwd is a git repo", async () => {
        const hook = buildGitContextHook(gitDir);
        const result = await hook({ messages: makeMessages() } as ContextEvent);
        assert.ok(result, "hook should return messages");
        assert.ok(Array.isArray(result.messages));
        const first = result.messages[0];
        assert.ok(first);
        const content = (first as { content?: unknown }).content;
        let text: string;
        if (typeof content === "string") {
            text = content;
        } else if (Array.isArray(content)) {
            text = (content[0] as { text?: string })?.text ?? "";
        } else {
            text = "";
        }
        assert.match(text, /^<recent_git_commits>/);
        assert.match(text, /second commit/);
        assert.match(text, /first commit/);
        assert.match(text, /README\.md|src\.ts/);
        // Guidance lives inside the tag so it is never stale when new commits appear.
        assert.match(text, /reference/i);
    });

    it("injects uncommitted files (staged, unstaged, untracked) into the working_tree_changes tag", async () => {
        // gitDir has: staged.txt (staged), modified README.md (unstaged), untracked.txt (untracked)
        const hook = buildGitContextHook(gitDir);
        const result = await hook({ messages: makeMessages() } as ContextEvent);
        assert.ok(result, "hook should return messages");
        // Two leading messages: <recent_git_commits> then <working_tree_changes>
        assert.equal(result.messages.length >= 2, true, "expected at least 2 leading messages");
        const first = result.messages[0];
        const second = result.messages[1];
        const firstContent = (first as { content?: unknown }).content;
        const secondContent = (second as { content?: unknown }).content;
        const firstText =
            typeof firstContent === "string"
                ? firstContent
                : ((firstContent as Array<{ text?: string }>)[0]?.text ?? "");
        const secondText =
            typeof secondContent === "string"
                ? secondContent
                : ((secondContent as Array<{ text?: string }>)[0]?.text ?? "");

        // First tag is recent_git_commits
        assert.match(firstText, /^<recent_git_commits>/);
        // Second tag is working_tree_changes
        assert.match(secondText, /^<working_tree_changes>/);
        assert.match(secondText, /staged\.txt/);
        assert.match(secondText, /untracked\.txt/);
    });
});

describe("builtin git-context extension — uncommitted files", () => {
    it("readUncommittedFiles returns staged, unstaged, and untracked items", async () => {
        const files = await readUncommittedFiles(gitDir);
        // gitDir setup: staged.txt (A), README.md (M), untracked.txt (??)
        assert.ok(files.staged.some((s) => s.includes("staged.txt")));
        assert.ok(files.unstaged.some((s) => s.includes("README.md")));
        assert.ok(files.untracked.some((s) => s.includes("untracked.txt")));
    });

    it("readUncommittedFiles returns empty arrays on a non-git directory", async () => {
        const files = await readUncommittedFiles(nonGitDir);
        // Errors are swallowed; all three arrays fall back to [].
        assert.equal(files.staged.length, 0);
        assert.equal(files.unstaged.length, 0);
        assert.equal(files.untracked.length, 0);
    });
});

describe("builtin git-context extension — activator", () => {
    it("returns undefined when cwd is not a git repo", async () => {
        const activator = buildGitContextActivator();
        const result = await activator({ cwd: nonGitDir });
        assert.equal(result, undefined);
    });

    it("returns {contextHooks} (no systemPrompt) when cwd is a git repo", async () => {
        const activator = buildGitContextActivator();
        const result = await activator({ cwd: gitDir });
        assert.ok(result, "activator should return a contribution");
        assert.ok(result.contextHooks && result.contextHooks.length > 0);
        assert.equal(result.contextHooks.length, 1);
        // Guidance lives inside the context hook's injected tag, not in
        // systemPrompt — so systemPrompt contribution must be absent.
        assert.equal(result.systemPrompt, undefined);
    });
});
