import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { IM_CWD_PREFIX, makeImCwd, parseImCwd } from "@taco-ai/protocol";
import {
    IM_FS_TOOL_NAMES,
    IM_SHELL_TOOL_NAME,
    makeImSessionsRoot,
} from "../../src/channels/virtualWorkspace.ts";
import { defaultTools } from "../../src/tools/index.ts";

describe("virtualWorkspace", () => {
    it("makeImCwd/parseImCwd round-trips plain ids", () => {
        const cwd = makeImCwd("feishu-app1", "u1", "c1");
        assert.equal(cwd, "im://feishu-app1/u1/c1");
        assert.deepEqual(parseImCwd(cwd), { channelId: "feishu-app1", peerId: "u1", chatId: "c1" });
    });

    it("round-trips ids containing encoded slashes", () => {
        const cwd = makeImCwd("ch", "peer/with/slash", "chat");
        assert.deepEqual(parseImCwd(cwd), {
            channelId: "ch",
            peerId: "peer/with/slash",
            chatId: "chat",
        });
    });

    it("parseImCwd returns undefined for non-im cwd", () => {
        assert.equal(parseImCwd("/home/user/proj"), undefined);
    });

    it("parseImCwd returns undefined for malformed im cwd", () => {
        assert.equal(parseImCwd("im://onlychannel"), undefined);
        assert.equal(parseImCwd("im://a//c"), undefined);
    });

    it("parseImCwd returns undefined for trailing/missing segment edge cases", () => {
        assert.equal(parseImCwd("im://ch/peer/"), undefined); // empty chatId
        assert.equal(parseImCwd("im://ch//chat"), undefined); // empty peerId
        assert.equal(parseImCwd("im:///a/b"), undefined); // empty channelId
    });

    it("parseImCwd returns undefined for invalid percent-encoding", () => {
        assert.equal(parseImCwd("im://ch/%zz/c1"), undefined);
    });

    it("round-trips percent-encoded reserved characters in peer/chat ids", () => {
        const cwd = makeImCwd("ch", "peer?a=1&b=2", "chat#1");
        assert.deepEqual(parseImCwd(cwd), {
            channelId: "ch",
            peerId: "peer?a=1&b=2",
            chatId: "chat#1",
        });
    });

    /**
     * An empty id produces a key parseImCwd cannot parse, which breaks the
     * outbound reply path silently. Fail at construction instead.
     */
    it("rejects an empty peerId or chatId", () => {
        assert.throws(() => makeImCwd("ch", "", "c1"), /peerId must not be empty/);
        assert.throws(() => makeImCwd("ch", "u1", ""), /chatId must not be empty/);
    });

    it("makeImSessionsRoot joins under tacoHome", () => {
        // Path is joined with `path.join` (POSIX "/" on Linux/macOS, "\"
        // on Windows). The original assertion hard-coded "/" and broke
        // on Windows.
        assert.equal(
            makeImSessionsRoot("/home/x/.taco", "ch1"),
            join("/home/x/.taco", "sessions", "im", "ch1"),
        );
    });

    it("IM_CWD_PREFIX is im://", () => {
        assert.equal(IM_CWD_PREFIX, "im://");
    });

    it("IM fs/shell tool names match the registered tool names", () => {
        const registered = defaultTools({}).map((t) => t.name);
        for (const disabled of IM_FS_TOOL_NAMES) {
            assert.ok(registered.includes(disabled), `disabled tool ${disabled} is not registered`);
        }
        // Guard: non-fs tools must never be in the disabled list (would break IM sessions).
        const fsTools = new Set(["read", "write", "edit", "grep", "glob"]);
        for (const disabled of IM_FS_TOOL_NAMES) {
            assert.ok(fsTools.has(disabled), `${disabled} is not an fs tool`);
        }
        assert.equal(IM_SHELL_TOOL_NAME, "shell");
        assert.ok(registered.includes(IM_SHELL_TOOL_NAME), "shell tool is registered");
    });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

describe("WorkspaceRuntime im:// construction", () => {
    it("constructs without crashing and disables fs tools", () => {
        const scratch = mkdtempSync(path.join(tmpdir(), "im-scratch-"));
        const sessionsRoot = mkdtempSync(path.join(tmpdir(), "im-sessions-"));
        const ws = new WorkspaceRuntime({
            cwd: "im://mock-1/u1/c1",
            fsCwd: scratch,
            workspaceKey: "im://mock-1/u1/c1",
            sessionsRoot,
            disableFsTools: true,
            // Remaining required options follow the minimal construction from existing runtime tests.
        } as ConstructorParameters<typeof WorkspaceRuntime>[0]);
        assert.equal(ws.sessionCwd, scratch);
        assert.equal(ws.workspaceKey, "im://mock-1/u1/c1");
        const names = ws.tools.map((t) => t.name);
        const disabled = [...IM_FS_TOOL_NAMES, IM_SHELL_TOOL_NAME];
        for (const fs of disabled) {
            assert.ok(!names.includes(fs), `expected ${fs} to be disabled`);
        }
    });
});
