// Shell-family tool tests: runShell signal escalation, shellTool.

import { strict as assert } from "node:assert";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
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
    // Both cases drive a `trap '' TERM` busy loop through /bin/sh, which has no
    // Windows equivalent — the command exits immediately there, so the timeout
    // path under test is never entered.
    const posixOnly = process.platform === "win32" ? "requires POSIX sh" : false;

    it("SIGKILLs a child that ignores SIGTERM after a timeout", { skip: posixOnly }, async () => {
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

    it("SIGKILLs a child that ignores SIGTERM after an abort signal", {
        skip: posixOnly,
    }, async () => {
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
        for (const useShell of [false, true]) {
            it(`SIGKILLs a SIGTERM-resistant ${useShell ? "grandchild after its shell exits" : "child launched with explicit argv"}`, async () => {
                const dir = mkdtempSync(join(tmpdir(), "taco-shell-escalation-"));
                const ready = join(dir, "ready");
                const script = `
                    const { writeFileSync } = await import("node:fs");
                    process.on("SIGTERM", () => {});
                    setTimeout(() => {
                        process.stdout.write("natural exit");
                        process.exit(0);
                    }, 5000);
                    writeFileSync(process.argv[1], "");
                `;
                const args = ["--input-type=module", "-e", script, ready];
                const command = [process.execPath, ...args]
                    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
                    .join(" ");
                const controller = new AbortController();
                const pending = runShell(
                    useShell ? `${command} & wait` : process.execPath,
                    useShell ? null : args,
                    { cwd: dir, signal: controller.signal, sigkillDelayMs: 50 },
                );
                try {
                    // Abort only after the real command installed its handler;
                    // killing it during startup would bypass the escalation.
                    const deadline = Date.now() + 5_000;
                    while (!existsSync(ready)) {
                        assert.ok(Date.now() < deadline, "child did not become ready");
                        await setTimeout(5);
                    }
                    controller.abort();
                    const result = await pending;
                    assert.equal(result.details.interrupted, true);
                    assert.doesNotMatch(result.content[0]?.text ?? "", /natural exit/);
                } finally {
                    controller.abort();
                    await pending;
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        }

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
    it("runs fixed Git history without using an ambient Git directory", async (t) => {
        const cwd = mkdtempSync(join(tmpdir(), "taco-shell-git-"));
        t.after(() => rmSync(cwd, { recursive: true, force: true }));
        const git = (...args: string[]) => childProcess.execFileSync("git", ["-C", cwd, ...args]);
        git("init", "--quiet");
        git(
            "-c",
            "user.name=Taco",
            "-c",
            "user.email=taco@example.test",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "fixture commit",
        );
        const previous = process.env.GIT_DIR;
        t.after(() => {
            if (previous === undefined) delete process.env.GIT_DIR;
            else process.env.GIT_DIR = previous;
        });
        process.env.GIT_DIR = join(cwd, "unavailable");
        const broker = new PermissionBroker(() => ASK_CONFIG, { readOnly: true });
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const result = (await invokeTool(
            tool,
            { command: "git log --oneline" },
            context(cwd),
        )) as ShellToolResult;
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /fixture commit/);
        for (const command of ["git status --short", "git diff --stat"]) {
            const inspection = (await invokeTool(
                tool,
                { command },
                context(cwd),
            )) as ShellToolResult;
            assert.equal(inspection.isError, false, `${command}: ${textOf(inspection)}`);
        }
    });

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

    for (const trigger of ["timeout", "abort"]) {
        for (const taskkillCode of [0, 1]) {
            it(`Windows taskkill scrubs keys on ${trigger} with exit ${taskkillCode}`, async (t) => {
                const dir = mkdtempSync(join(tmpdir(), "taco-taskkill-env-"));
                const probe = join(dir, "env-probe.json");
                const store = new ProviderKeyStore({ anthropic: "taskkill-test-secret" });
                const platform = Object.getOwnPropertyDescriptor(process, "platform");
                assert.ok(platform);
                const realSpawn = childProcess.spawn;
                let child: ReturnType<typeof realSpawn> | undefined;
                let killerClosed: Promise<void> | undefined;
                let taskkillCalls = 0;
                let fallbackCalls = 0;
                // Exercise Windows dispatch on every host. A real subprocess
                // probes its inherited env and simulates taskkill's result.
                const mocked = t.mock.method(childProcess, "spawn", ((
                    ...args: Parameters<typeof realSpawn>
                ) => {
                    if (args[0] === "taskkill") {
                        taskkillCalls++;
                        assert.ok(child?.pid);
                        assert.deepEqual(args[1], ["/pid", String(child.pid), "/T", "/F"]);
                        assert.equal(args[2]?.windowsHide, true);
                        const killer = realSpawn(
                            process.execPath,
                            [
                                "-e",
                                "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ leaked: Boolean(process.env.ANTHROPIC_API_KEY) })); " +
                                    (taskkillCode === 0
                                        ? "process.kill(Number(process.argv[2]));"
                                        : "process.exitCode = 1;"),
                                probe,
                                String(child.pid),
                            ],
                            args[2],
                        );
                        killerClosed = new Promise((resolve) =>
                            killer.once("close", () => resolve()),
                        );
                        return killer;
                    }
                    child = realSpawn(...args);
                    const realKill = child.kill.bind(child);
                    t.mock.method(child, "kill", (signal?: NodeJS.Signals | number) => {
                        fallbackCalls++;
                        return realKill(signal);
                    });
                    return child;
                }) as typeof childProcess.spawn);
                syncBuiltinESMExports();
                Object.defineProperty(process, "platform", { value: "win32" });
                const controller = new AbortController();
                try {
                    const pending = runShell(
                        process.execPath,
                        ["-e", "setTimeout(() => process.stdout.write('natural exit'), 2000)"],
                        {
                            cwd: dir,
                            timeoutMs: trigger === "timeout" ? 30 : 5000,
                            signal: controller.signal,
                        },
                    );
                    if (trigger === "abort") controller.abort();
                    const result = await pending;
                    await killerClosed;
                    assert.equal(result.details.interrupted, true);
                    assert.doesNotMatch(result.content[0]?.text ?? "", /natural exit/);
                    assert.deepEqual(JSON.parse(readFileSync(probe, "utf8")), { leaked: false });
                    assert.equal(taskkillCalls, 1);
                    assert.equal(fallbackCalls, taskkillCode === 0 ? 0 : 1);
                } finally {
                    child?.kill();
                    await killerClosed;
                    Object.defineProperty(process, "platform", platform);
                    mocked.mock.restore();
                    syncBuiltinESMExports();
                    store.update({ anthropic: "" });
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        }
    }

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
