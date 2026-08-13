import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { resolveImExecutionCwd } from "../../src/server/imExecutionCwd.ts";

const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };
const DEFAULT_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
};

describe("resolveImExecutionCwd", () => {
    it("default policy returns the channel scratch and marks it shared", () => {
        const home = mkdtempSync(join(tmpdir(), "im-exec-"));
        const out = resolveImExecutionCwd({
            sessionsRoot: join(home, "sessions", "im", "wechat"),
            route: ROUTE,
            policy: DEFAULT_POLICY,
        });
        assert.equal(out.shared, true);
        assert.ok(out.executionCwd.endsWith(`${join("wechat", "scratch")}`));
        assert.equal(out.warning, undefined);
    });

    it("perChatScratch isolates to a per-chat dir and creates it", () => {
        const home = mkdtempSync(join(tmpdir(), "im-exec-"));
        const out = resolveImExecutionCwd({
            sessionsRoot: join(home, "sessions", "im", "wechat"),
            route: ROUTE,
            policy: { ...DEFAULT_POLICY, perChatScratch: true },
        });
        assert.equal(out.shared, false);
        assert.ok(out.executionCwd.includes("chats"));
        assert.ok(out.executionCwd.endsWith("scratch"));
        // Directory is created eagerly so tools can write immediately.
        assert.ok(existsSync(out.executionCwd));
    });

    it("a valid writable binding wins over perChatScratch", () => {
        const home = mkdtempSync(join(tmpdir(), "im-exec-"));
        const bound = mkdtempSync(join(tmpdir(), "im-bound-"));
        const out = resolveImExecutionCwd({
            sessionsRoot: join(home, "sessions", "im", "wechat"),
            route: ROUTE,
            policy: {
                ...DEFAULT_POLICY,
                perChatScratch: true,
                binding: { executionCwd: bound },
            },
        });
        assert.equal(out.executionCwd, bound);
        assert.equal(out.shared, false);
    });

    it("a binding pointing at a file falls back to the shared scratch with a warning", () => {
        const home = mkdtempSync(join(tmpdir(), "im-exec-"));
        const file = join(home, "not-a-dir");
        writeFileSync(file, "x");
        const out = resolveImExecutionCwd({
            sessionsRoot: join(home, "sessions", "im", "wechat"),
            route: ROUTE,
            policy: { ...DEFAULT_POLICY, binding: { executionCwd: file } },
        });
        assert.equal(out.shared, true);
        assert.ok(out.warning);
        assert.ok(out.warning.includes(file));
    });

    it("a binding pointing at a nonexistent path falls back with a warning", () => {
        const home = mkdtempSync(join(tmpdir(), "im-exec-"));
        const missing = join(home, "no", "such", "dir");
        const out = resolveImExecutionCwd({
            sessionsRoot: join(home, "sessions", "im", "wechat"),
            route: ROUTE,
            policy: { ...DEFAULT_POLICY, binding: { executionCwd: missing } },
        });
        assert.equal(out.shared, true);
        assert.ok(out.warning);
    });
});
