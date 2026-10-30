// Shell-family tool tests: runShell signal escalation, shellTool, glob, grep.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createGlobTool } from "../../src/tools/glob.ts";
import { createGrepTool } from "../../src/tools/grep.ts";
import { runShell } from "../../src/tools/shell.ts";
import { createShellTool } from "../../src/tools/shellTool.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

// Traps SIGTERM so it does nothing, then busy-loops. Only SIGKILL (which
// cannot be trapped) can end it. A tight loop of short `sleep`s rather than
// one long `sleep N`: with `shell: true`, `sleep` runs as a grandchild of the
// spawned /bin/sh, and a shell stuck in a loop cannot `exec` itself away, so
// the signal reaches the process that is actually running at kill time.
const IGNORE_SIGTERM_AND_BUSY_LOOP = "trap '' TERM; while true; do sleep 0.1; done";

// A compound command: `/bin/sh` stays alive as the group leader and runs the
// `sleep` as a grandchild, which is the shape that used to leave the real
// process untouched and hold the inherited stdout pipe open.
const COMPOUND_COMMAND = "sleep 30 & wait";

describe("runShell — SIGTERM→SIGKILL escalation", () => {
    it("SIGKILLs a child that ignores SIGTERM after a timeout", async () => {
        const result = await runShell(IGNORE_SIGTERM_AND_BUSY_LOOP, null, {
            cwd: tmpdir(),
            timeoutMs: 50,
            sigkillDelayMs: 50,
        });
        assert.equal(result.details.interrupted, true);
        // What matters here is that the promise resolved at all: before the
        // fix, `if (!child.killed)` was always false right after
        // `child.kill("SIGTERM")`, so the SIGKILL escalation below it never
        // ran, and a child that traps SIGTERM would hang this call forever.
    });

    it("SIGKILLs a child that ignores SIGTERM after an abort signal", async () => {
        const controller = new AbortController();
        const pending = runShell(IGNORE_SIGTERM_AND_BUSY_LOOP, null, {
            cwd: tmpdir(),
            signal: controller.signal,
            sigkillDelayMs: 50,
        });
        controller.abort();
        const result = await pending;
        assert.equal(result.details.interrupted, true);
    });

    // Before the process-group kill, `runShell` awaited `close`, which needs
    // every inherited stdout/stderr pipe closed. The grandchild held them open,
    // so these calls only resolved once `sleep 30` finished on its own — a
    // timed-out or aborted compound command hung the tool, and any parent abort
    // awaiting it, for the full length of the command.
    if (process.platform !== "win32") {
        it("returns promptly when a compound command is killed by timeout", async () => {
            const started = Date.now();
            const result = await runShell(COMPOUND_COMMAND, null, {
                cwd: tmpdir(),
                timeoutMs: 50,
                sigkillDelayMs: 50,
            });
            assert.equal(result.details.interrupted, true);
            assert.ok(
                Date.now() - started < 5_000,
                `expected the grandchild to die with the process group, took ${Date.now() - started}ms`,
            );
        });

        it("returns promptly when a compound command is killed by abort", async () => {
            const controller = new AbortController();
            const started = Date.now();
            const pending = runShell(COMPOUND_COMMAND, null, {
                cwd: tmpdir(),
                signal: controller.signal,
                sigkillDelayMs: 50,
            });
            // Aborting synchronously would fire before `/bin/sh` has forked the
            // grandchild, leaving nothing for the process-group kill to catch —
            // the test would then pass with or without the fix.
            await setTimeout(200);
            controller.abort();
            const result = await pending;
            assert.equal(result.details.interrupted, true);
            assert.ok(
                Date.now() - started < 5_000,
                `expected the grandchild to die with the process group, took ${Date.now() - started}ms`,
            );
        });
    }
});

const ASK_CONFIG = { mode: "ask" as const, rules: [] };

function context(cwd: string) {
    return { env: new NodeExecutionEnv({ cwd }) };
}

type ShellToolResult = {
    content: Array<{ type?: string; text?: string }>;
    details: {
        exitCode: number;
        interrupted: boolean;
        reason?: "permission_denied" | "permission_timeout" | "permission_aborted";
    };
    isError: boolean;
};

function textOf(result: ShellToolResult): string {
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("expected text content");
    return first.text ?? "";
}

describe("shellTool description", () => {
    it("tells the model that here-documents always need approval", () => {
        // The permission parser marks any heredoc as unanalyzable, so a
        // heredoc command always blocks on an approval prompt. The tool
        // description is the model's only cue to use a file or `-c` instead.
        const description = createShellTool().description;
        assert.match(description, /here-(documents|strings)/i);
        assert.match(description, /approval/i);
    });
});

describe("shellTool permission results", () => {
    it("returns an explicit failed result when the user denies approval", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG);
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const requestId = new Promise<string>((resolve) => {
            broker.once("requested", (request) => resolve(request.requestId));
        });
        const pending = invokeTool(
            tool,
            { command: "echo approved-only-after-user-action" },
            context("/tmp"),
            { toolCallId: "tool-call-1" },
        );
        broker.resolve(await requestId, false, "once");
        const result = (await pending) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_denied");
        assert.equal(result.details.exitCode, -1);
        assert.match(textOf(result), /The user denied this command/);
        assert.match(textOf(result), /another route/);
        assert.match(textOf(result), /askUser/);
    });

    it("returns a timeout-specific failed result when approval expires", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG, { requestTimeoutMs: 5 });
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const result = (await invokeTool(
            tool,
            { command: "echo should-not-run" },
            context("/tmp"),
            { toolCallId: "tool-call-1" },
        )) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_timeout");
        assert.match(textOf(result), /permission request timed out/);
        assert.match(textOf(result), /Do not retry automatically/);
        assert.match(textOf(result), /askUser/);
    });

    it("returns an aborted failed result when the turn is cancelled", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG);
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const controller = new AbortController();
        const pending = invokeTool(tool, { command: "echo should-not-run" }, context("/tmp"), {
            toolCallId: "tool-call-1",
            signal: controller.signal,
        });
        controller.abort();
        const result = (await pending) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_aborted");
        assert.match(textOf(result), /current turn was cancelled/);
        assert.match(textOf(result), /Do not retry automatically/);
    });

    it("maps a policy denial (no denialReason) to permission_denied", async () => {
        // A read-only broker degrades "ask" to an immediate deny without ever
        // reaching the UI, so the decision carries no denialReason. That is a
        // known path, not an unrecognised one — see deniedResult.
        const broker = new PermissionBroker(() => ASK_CONFIG, { readOnly: true });
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const result = (await invokeTool(tool, { command: "rm -rf /tmp/nope" }, context("/tmp"), {
            toolCallId: "tool-call-1",
        })) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_denied");
        assert.equal(result.details.exitCode, -1);
        assert.match(textOf(result), /blocked by the workspace's permission policy/);
        assert.ok(
            !textOf(result).includes("askUser"),
            "policy denial has no interactive user to ask — must not route to askUser",
        );
    });

    it("propagates isError from shell execution failures", async () => {
        const tool = createShellTool();
        const result = (await invokeTool(tool, { command: "exit 7" }, context("/tmp"), {
            toolCallId: "tool-call-1",
        })) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.exitCode, 7);
        assert.equal(result.details.reason, undefined);
    });
});

describe("shell tool env scrubbing", () => {
    afterEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.endsWith("_API_KEY")) delete process.env[k];
        }
    });

    it("does not expose injected provider keys to executed commands", {
        skip: process.platform === "win32",
    }, async () => {
        // Constructing the store mirrors the key into process.env (for pi)
        // and records it as injected so shell.ts can scrub it.
        const store = new ProviderKeyStore({ anthropic: "sk-ant-secret-1234567890" });
        assert.equal(store.has("anthropic"), true);
        assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-secret-1234567890");

        const tool = createShellTool();
        const result = (await invokeTool(tool, { command: "env" }, context("/tmp"), {
            toolCallId: "tool-call-1",
        })) as ShellToolResult;

        assert.equal(textOf(result).includes("sk-ant-secret-1234567890"), false);
    });
});

describe("glob tool", () => {
    let dir: string;
    let env: NodeExecutionEnv;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-glob-"));
        env = new NodeExecutionEnv({ cwd: dir });
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "node_modules"));
        mkdirSync(join(dir, "secrets"));
        writeFileSync(join(dir, "src", "a.ts"), "a");
        writeFileSync(join(dir, "src", "b.ts"), "b");
        writeFileSync(join(dir, "src", "c.js"), "c");
        // Only ignores `secrets/`, not `node_modules`.
        // This distinguishes "safe defaults suppress node_modules" from ".gitignore suppresses secrets/".
        writeFileSync(join(dir, ".gitignore"), "secrets/\n");
        writeFileSync(join(dir, "node_modules", "dep.ts"), "dep");
        writeFileSync(join(dir, "secrets", "k.ts"), "k");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("matches by pattern and returns relative paths", async () => {
        const tool = createGlobTool();
        const res = await invokeTool(
            tool,
            { pattern: "src/**/*.ts" },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts"));
        assert.ok(text.includes("src/b.ts"));
        assert.ok(!text.includes("c.js"));
    });

    it("respects safe defaults even without .gitignore mention", async () => {
        const tool = createGlobTool();
        const res = await invokeTool(tool, { pattern: "**/*.ts" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"), "should exclude node_modules via safe defaults");
    });

    it("respects .gitignore user-ignored paths", async () => {
        const tool = createGlobTool();
        const res = await invokeTool(tool, { pattern: "**/*.ts" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"), "should respect .gitignore 'secrets/' entry");
    });
});

type GrepDetails = { count: number; truncated: boolean };

describe("grep tool", () => {
    let dir: string;
    let env: NodeExecutionEnv;
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-grep-"));
        env = new NodeExecutionEnv({ cwd: dir });
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "node_modules"));
        mkdirSync(join(dir, "secrets")); // user-specific, NOT in safe defaults
        writeFileSync(join(dir, "src", "a.ts"), "const foo = 1;\nconst bar = 2;\n");
        writeFileSync(join(dir, "src", "b.ts"), "function baz() { return foo; }\n");
        writeFileSync(join(dir, "node_modules", "dep.ts"), "export const foo = 'shadow';");
        writeFileSync(join(dir, "secrets", "config.ts"), "export const foo = 'hidden';");
        // Only user-ignores `secrets/`, NOT `node_modules` (latter is a safe default)
        writeFileSync(join(dir, ".gitignore"), "secrets/\n");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("finds a literal pattern and reports file:line", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/a.ts:1:"));
        assert.ok(text.includes("src/b.ts:1:"));
        assert.ok(!text.includes("const bar"));
    });

    it("filters by glob", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "foo", glob: "*.ts" },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        // `.glob filter means we'd only check files that match
        // (ripgrep's --glob semantics: filename pattern)
        // Both valid paths search the same files; just check that filter narrows results.
        assert.ok(text.length > 0); // gets some matches
        assert.ok(text.split("\n").every((line) => !line.startsWith("secrets/")));
    });

    it("respects safe defaults (excludes node_modules)", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("node_modules"));
    });

    it("respects .gitignore (excludes secrets/)", async () => {
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "foo" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(!text.includes("secrets"));
    });

    it("case-insensitive flag works", async () => {
        writeFileSync(join(dir, "src", "c.ts"), "const FOO = 3;\n");
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "FOO", ignoreCase: true },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/c.ts:1:"));
    });

    it("clips a long matching line", async () => {
        writeFileSync(join(dir, "src", "min.js"), `var longneedle="${"x".repeat(5000)}";\n`);
        const tool = createGrepTool();
        const res = await invokeTool(
            tool,
            { pattern: "longneedle" },
            { env },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.includes("src/min.js:1:"));
        assert.ok(text.length < 1000, `got ${text.length} chars`);
        assert.equal((res.details as GrepDetails).truncated, true);
    });

    it("caps total output under the line cap", async () => {
        mkdirSync(join(dir, "wide"));
        // 200 rows (under MAX_LINES) of ~400 chars each would be ~80k chars unclipped.
        const row = `widetoken ${"y".repeat(400)}`;
        writeFileSync(join(dir, "wide", "w.txt"), `${Array(200).fill(row).join("\n")}\n`);
        const tool = createGrepTool();
        const res = await invokeTool(tool, { pattern: "widetoken" }, { env }, { toolCallId: "tc" });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        assert.ok(text.length <= 51_000, `got ${text.length} chars`);
        const details = res.details as GrepDetails;
        assert.equal(details.count, 200);
        assert.equal(details.truncated, true);
        assert.match(text, /more\)$/);
    });
});
