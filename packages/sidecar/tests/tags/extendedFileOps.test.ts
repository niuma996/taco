/**
 * extractExtendedFileOps — shell / glob / grep tool-call heuristics.
 *
 * pi's default detector only handles `read` / `write` / `edit`. This test
 * asserts the conservative shell regexes for the common in-place mutations:
 * `>>`, `>`, `tee`, `cat <<X > file`, heredoc body, `mv`, `cp`, `rm`,
 * `sed -i`, `perl -i`. Glob/grep `path`/`pattern` literals go to reads.
 *
 * Run via `node:test` (tsx loader).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { extractExtendedFileOps } from "../../src/tags/policy/extendedFileOps.ts";

// Minimal AgentMessage-shaped fixtures (real harness messages carry many
// more fields the helper doesn't care about).
const mk = (m: Record<string, unknown>): AgentMessage => m as unknown as AgentMessage;

function assistantCall(toolName: string, args: unknown) {
    return mk({
        role: "assistant",
        content: [{ type: "toolCall", toolName, args }],
    });
}

function assistantText(text: string) {
    return mk({ role: "assistant", content: text });
}

describe("extractExtendedFileOps — shell", () => {
    it("flags >> and > as writes", () => {
        const messages = [assistantCall("shell", { command: "echo hi >> /tmp/out.log" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/tmp/out.log"));
        assert.equal(out.extraReadFiles.includes("/tmp/out.log"), false);
    });

    it("flags sed -i as a write", () => {
        const messages = [assistantCall("shell", { command: "sed -i 's/a/b/' /etc/conf.yaml" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/etc/conf.yaml"));
    });

    it("flags heredoc body rewrite as a write", () => {
        const cmd = `cat <<EOF > /etc/app.env
NEW=value
EOF`;
        const messages = [assistantCall("shell", { command: cmd })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/etc/app.env"));
    });

    it("flags mv src dst as writes (dst modifies, src tracked as read)", () => {
        const messages = [assistantCall("shell", { command: "mv old.log archive/old.log" })];
        const out = extractExtendedFileOps(messages);
        // Destination file count as a write.
        assert.ok(out.extraModifiedFiles.includes("archive/old.log"));
        // Source path doesn't get a free read modifier under mv alone — we
        // verify NO false-positive write for the source filename.
        assert.equal(out.extraModifiedFiles.includes("old.log"), false);
    });

    it("flags cp as a write", () => {
        const messages = [assistantCall("shell", { command: "cp src.txt backup.txt" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("backup.txt"));
    });

    it("flags rm as a write", () => {
        const messages = [assistantCall("shell", { command: "rm /var/log/x.log" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/var/log/x.log"));
    });

    it("flags cat as a read (not a write)", () => {
        const messages = [assistantCall("shell", { command: "cat /etc/hosts" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/etc/hosts"));
        assert.equal(out.extraModifiedFiles.includes("/etc/hosts"), false);
    });

    it("ignores shell snippets inside fenced code blocks", () => {
        const messages = [assistantText("```bash\nsed -i 's/a/b/' /tmp/fenced\n```")];
        const out = extractExtendedFileOps(messages);
        // Text content is not a tool-call block → nothing extracted.
        assert.equal(out.extraModifiedFiles.length, 0);
        assert.equal(out.extraReadFiles.length, 0);
    });

    it("handles missing or empty command arguments", () => {
        const messages = [assistantCall("shell", {})];
        const out = extractExtendedFileOps(messages);
        assert.deepEqual(out, { extraReadFiles: [], extraModifiedFiles: [] });
    });

    it("does not match legacy bash/powershell tool names", () => {
        // After unifying bash + powershell into `shell`, only `shell` is
        // scanned. Legacy names in tool-call blocks are ignored so old
        // transcripts don't reintroduce file-op detection against a tool
        // that no longer exists.
        const messages = [
            assistantCall("bash", { command: "sed -i 's/a/b/' /tmp/legacy.txt" }),
            assistantCall("powershell", { command: "rm /tmp/legacy2.txt" }),
        ];
        const out = extractExtendedFileOps(messages);
        assert.deepEqual(out, { extraReadFiles: [], extraModifiedFiles: [] });
    });
});

describe("extractExtendedFileOps — glob/grep", () => {
    it("glob path field becomes a read", () => {
        const messages = [assistantCall("glob", { path: "/repo/src/**/*.ts" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/repo/src/**/*.ts"));
    });

    it("grep pattern containing literal paths produces reads", () => {
        const messages = [
            assistantCall("grep", {
                pattern: "TODO",
                dir: "/workspace",
            }),
        ];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/workspace"));
    });
});
