import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CommandPermissionConfig, CommandPermissionRequest } from "@taco-ai/protocol";
import {
    evaluateCommand,
    evaluateCommandForImWorkspace,
} from "../../src/permissions/commandPolicy.ts";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";

const askConfig: CommandPermissionConfig = { mode: "ask", rules: [] };

describe("evaluateCommand", () => {
    it("auto-allows strict read-only commands in auto mode", () => {
        const result = evaluateCommand("git status", { mode: "auto", rules: [] });

        assert.equal(result.behavior, "allow");
        assert.equal(result.risk, "readOnly");
    });

    it("requires approval for destructive commands even with unknown modes", () => {
        const result = evaluateCommand("git reset --hard HEAD", { mode: "ask", rules: [] });

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "destructive");
        assert.match(result.reason, /discard/i);
    });

    it("matches a global exact allow rule", () => {
        const result = evaluateCommand("pnpm test", {
            ...askConfig,
            rules: ["pnpm test"],
        });

        assert.equal(result.behavior, "allow");
        assert.equal(result.source, "rule");
    });

    it("matches a wildcard pattern rule", () => {
        const result = evaluateCommand("mmx search query --q hi", {
            ...askConfig,
            rules: ["mmx *"],
        });

        assert.equal(result.behavior, "allow");
        assert.equal(result.source, "rule");
    });

    it("matches a command via wildcard rule (legacy `X:*` prefix is now `X *`)", () => {
        const result = evaluateCommand("npm install", {
            ...askConfig,
            rules: ["npm *"],
        });

        assert.equal(result.behavior, "allow");
        assert.equal(result.source, "rule");
    });

    it("does not match a wildcard pattern with different base command", () => {
        const result = evaluateCommand("mmxly foo", {
            ...askConfig,
            rules: ["mmx *"],
        });

        assert.equal(result.behavior, "ask");
        assert.notEqual(result.source, "rule");
    });

    it("does not allow a shell wrapper through a rule", () => {
        const result = evaluateCommand("bash -c 'rm -rf /tmp/demo'", {
            mode: "ask",
            rules: ["bash -c 'rm -rf /tmp/demo'"],
        });

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "destructive");
    });

    it("upgrades a compound command to its highest risk", () => {
        const result = evaluateCommand("git status && terraform destroy", askConfig);

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "destructive");
    });

    it("does not auto-allow read-only commands with redirections", () => {
        const result = evaluateCommand("cat > important-file", { mode: "auto", rules: [] });

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "workspaceWrite");
    });

    it("does not auto-allow git branch -D through prefix matching", () => {
        const result = evaluateCommand("git branch -D foo", { mode: "auto", rules: [] });

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "workspaceWrite");
    });

    it("does not auto-allow commands with command substitution", () => {
        const result = evaluateCommand("ls $(pwd)", { mode: "auto", rules: [] });

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "workspaceWrite");
    });

    it("denies privilege escape commands", () => {
        const result = evaluateCommand("sudo apt-get update", askConfig);

        assert.equal(result.behavior, "deny");
        assert.equal(result.risk, "privilegeEscape");
    });

    it("requires approval for external side-effect commands", () => {
        const result = evaluateCommand("git push origin main", askConfig);

        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "externalSideEffect");
    });

    it("rejects uppercase shell wrappers via the case-insensitive gate (II-6)", () => {
        // Regression: SHELL_WRAPPERS.has(first) was case-sensitive, so an
        // uppercase `BASH -c '...'` slipped past the shell-wrapper gate in
        // matchesRule and could match a rule. The gate now lowercases.
        const result = evaluateCommand("BASH -c 'echo hi'", {
            mode: "ask",
            rules: ["BASH *"],
        });

        // Wrapper gate blocks the rule match, so source is not "rule".
        assert.notEqual(result.source, "rule");
        // Command substitution risk: `$()` / backticks not present, so this is
        // workspaceWrite and asks.
        assert.equal(result.behavior, "ask");
        assert.equal(result.risk, "workspaceWrite");
    });
});

describe("PermissionBroker", () => {
    it("remembers a session approval for the exact command", async () => {
        const broker = new PermissionBroker(() => askConfig);
        const requestId = new Promise<string>((resolve) => {
            broker.once("requested", (value) => resolve(value.requestId));
        });
        const pending = broker.evaluateAndRequest({
            sessionId: "session-1",
            toolCallId: "call-1",
            command: "pnpm test",
        });
        broker.resolve(await requestId, true, "session");
        assert.equal((await pending).approved, true);

        const next = await broker.evaluateAndRequest({
            sessionId: "session-1",
            toolCallId: "call-2",
            command: "pnpm test",
        });
        assert.equal(next.approved, true);
        assert.equal(next.evaluation.source, "rule");
    });

    it("rejects pending requests when the session is cleaned up", async () => {
        const broker = new PermissionBroker(() => askConfig, { requestTimeoutMs: 60_000 });
        const pending = broker.evaluateAndRequest({
            sessionId: "session-1",
            toolCallId: "call-1",
            command: "rm -rf /tmp/demo",
        });
        broker.cleanupSession("session-1");
        const decision = await pending;
        assert.equal(decision.approved, false);
        assert.equal(decision.denialReason, "aborted");
    });

    it("rejects all pending requests when cleaned up", async () => {
        const broker = new PermissionBroker(() => askConfig, { requestTimeoutMs: 60_000 });
        const pending = broker.evaluateAndRequest({
            sessionId: "session-1",
            toolCallId: "call-1",
            command: "rm -rf /tmp/demo",
        });
        broker.cleanupAll();
        const decision = await pending;
        assert.equal(decision.approved, false);
        assert.equal(decision.denialReason, "aborted");
    });

    it("times out pending requests after the configured timeout", async () => {
        const broker = new PermissionBroker(() => askConfig, { requestTimeoutMs: 10 });
        const decision = await broker.evaluateAndRequest({
            sessionId: "session-1",
            toolCallId: "call-1",
            command: "rm -rf /tmp/demo",
        });
        assert.equal(decision.approved, false);
        assert.equal(decision.scope, "once");
        assert.equal(decision.denialReason, "timeout");
    });

    it("attaches resolved display context to emitted request", async () => {
        const resolver = async (sid: string) =>
            sid === "child-1"
                ? { displaySessionId: "root-1", displayToolCallId: "root-call-A" }
                : { displaySessionId: sid, displayToolCallId: undefined };
        const broker = new PermissionBroker(() => askConfig, { resolveDisplayContext: resolver });
        const requestPromise = new Promise<CommandPermissionRequest>((resolve) => {
            broker.once("requested", (r) => resolve(r));
        });
        void broker.evaluateAndRequest({
            sessionId: "child-1",
            toolCallId: "bash-call-1",
            command: "rm -rf /tmp/demo",
        });
        const request = await requestPromise;
        assert.equal(request.sessionId, "child-1");
        assert.equal(request.toolCallId, "bash-call-1");
        assert.equal(request.displaySessionId, "root-1");
        assert.equal(request.displayToolCallId, "root-call-A");
        broker.cleanupAll();
    });

    it("falls back when resolver returns no displayToolCallId", async () => {
        const resolver = async (sid: string) => ({
            displaySessionId: sid,
            displayToolCallId: undefined as string | undefined,
        });
        const broker = new PermissionBroker(() => askConfig, { resolveDisplayContext: resolver });
        const requestPromise = new Promise<CommandPermissionRequest>((resolve) => {
            broker.once("requested", (r) => resolve(r));
        });
        void broker.evaluateAndRequest({
            sessionId: "main-1",
            toolCallId: "bash-1",
            command: "rm -rf /tmp/demo",
        });
        const request = await requestPromise;
        assert.equal(request.displaySessionId, "main-1");
        assert.equal(request.displayToolCallId, undefined);
        broker.cleanupAll();
    });

    it("falls back when resolver throws", async () => {
        const broker = new PermissionBroker(() => askConfig, {
            resolveDisplayContext: async () => {
                throw new Error("boom");
            },
        });
        const requestPromise = new Promise<CommandPermissionRequest>((resolve) => {
            broker.once("requested", (r) => resolve(r));
        });
        void broker.evaluateAndRequest({
            sessionId: "child-1",
            toolCallId: "bash-1",
            command: "rm -rf /tmp/demo",
        });
        const request = await requestPromise;
        assert.equal(request.displaySessionId, "child-1");
        assert.equal(request.displayToolCallId, undefined);
        broker.cleanupAll();
    });

    it("stores session approvals against the root session so child respawns inherit", async () => {
        const resolver = async (sid: string) =>
            sid === "root-1"
                ? { displaySessionId: "root-1", displayToolCallId: undefined }
                : { displaySessionId: "root-1", displayToolCallId: "root-agent-tc" };
        const broker = new PermissionBroker(() => askConfig, { resolveDisplayContext: resolver });

        // Child-1 prompts, user approves "for session".
        const requestIdPromise = new Promise<string>((resolve) => {
            broker.once("requested", (value) => resolve(value.requestId));
        });
        const pending1 = broker.evaluateAndRequest({
            sessionId: "child-1",
            toolCallId: "call-1",
            command: "pnpm test",
        });
        broker.resolve(await requestIdPromise, true, "session");
        assert.equal((await pending1).approved, true);

        // Child-1 cleaned up — rules live on the root, not on the child.
        broker.cleanupSession("child-1");

        // Child-2 (fresh respawn) should inherit the approval.
        const decision2 = await broker.evaluateAndRequest({
            sessionId: "child-2",
            toolCallId: "call-2",
            command: "pnpm test",
        });
        assert.equal(decision2.approved, true);
        assert.equal(decision2.evaluation.source, "rule");
    });

    it("root approvals propagate to subagent evaluations within the same lifetime", async () => {
        const resolver = async (sid: string) =>
            sid === "root-1"
                ? { displaySessionId: "root-1", displayToolCallId: undefined }
                : { displaySessionId: "root-1", displayToolCallId: "root-agent-tc" };
        const broker = new PermissionBroker(() => askConfig, { resolveDisplayContext: resolver });

        // Root itself prompts for a command, user approves for the session.
        const requestIdPromise = new Promise<string>((resolve) => {
            broker.once("requested", (value) => resolve(value.requestId));
        });
        const pending = broker.evaluateAndRequest({
            sessionId: "root-1",
            toolCallId: "call-1",
            command: "pnpm build",
        });
        broker.resolve(await requestIdPromise, true, "session");
        assert.equal((await pending).approved, true);

        // Subagent evaluate same command — inherits from root.
        const decision = await broker.evaluateAndRequest({
            sessionId: "child-1",
            toolCallId: "call-2",
            command: "pnpm build",
        });
        assert.equal(decision.approved, true);
        assert.equal(decision.evaluation.source, "rule");
    });
});

describe("evaluateCommandForImWorkspace", () => {
    const GLOBAL: CommandPermissionConfig = { mode: "ask", rules: [] };

    it("denies privilege escalation even when the command is allow-listed", () => {
        const ev = evaluateCommandForImWorkspace("sudo ls", GLOBAL, {
            mode: "auto",
            allow: ["sudo *", "ls"],
        });
        assert.equal(ev.behavior, "deny");
        assert.equal(ev.risk, "privilegeEscape");
    });

    it("denies a channel deny-rule match", () => {
        const ev = evaluateCommandForImWorkspace("git push", GLOBAL, {
            mode: "auto",
            allow: ["git *"],
            deny: ["git push *"],
        });
        assert.equal(ev.behavior, "deny");
    });

    it("does not let a deny rule for rm swallow rmdir", () => {
        const ev = evaluateCommandForImWorkspace("rmdir empty", GLOBAL, {
            mode: "auto",
            allow: ["rmdir *"],
            deny: ["rm *"],
        });
        assert.equal(ev.behavior, "allow");
    });

    it("denies destructive and external-side-effect commands under auto", () => {
        for (const cmd of ["rm -rf build", "npm publish"]) {
            const ev = evaluateCommandForImWorkspace(cmd, GLOBAL, {
                mode: "auto",
                allow: ["* *"],
            });
            assert.equal(ev.behavior, "deny", cmd);
        }
    });

    it("denies anything outside the allow list", () => {
        const ev = evaluateCommandForImWorkspace("cat f", GLOBAL, {
            mode: "auto",
            allow: ["ls"],
        });
        assert.equal(ev.behavior, "deny");
    });

    it("allows an allow-listed benign command under auto", () => {
        const ev = evaluateCommandForImWorkspace("pnpm build", GLOBAL, {
            mode: "auto",
            allow: ["pnpm *"],
        });
        assert.equal(ev.behavior, "allow");
    });

    it("with auto and no allow list, only strict read-only commands pass", () => {
        assert.equal(
            evaluateCommandForImWorkspace("pwd", GLOBAL, { mode: "auto" }).behavior,
            "allow",
        );
        assert.equal(
            evaluateCommandForImWorkspace("pnpm build", GLOBAL, { mode: "auto" }).behavior,
            "ask",
        );
    });

    it("evaluates every segment of a compound command", () => {
        const ev = evaluateCommandForImWorkspace("ls && sudo rm -rf /", GLOBAL, {
            mode: "auto",
            allow: ["ls", "rm *"],
        });
        assert.equal(ev.behavior, "deny");
    });

    // Regression: matchesRule anchors on the start of the string it is given,
    // so checking deny against the whole compound command let a denied segment
    // through (`ls && cat x` did not match a `cat:*` deny rule). Every segment
    // must be checked independently. These cases carry no privilegeEscape /
    // destructive risk, so nothing else would catch them.
    it("applies deny rules to every segment, not just the first", () => {
        const policy = {
            mode: "auto" as const,
            allow: ["ls", "cat *"],
            deny: ["cat *"],
        };
        for (const cmd of [
            "cat /etc/passwd",
            "ls && cat /etc/passwd",
            "ls; cat /etc/passwd",
            "ls | cat",
        ]) {
            assert.equal(
                evaluateCommandForImWorkspace(cmd, GLOBAL, policy).behavior,
                "deny",
                `expected deny for: ${cmd}`,
            );
        }
    });

    it("ask mode reproduces the global evaluator", () => {
        assert.deepEqual(
            evaluateCommandForImWorkspace("pnpm build", GLOBAL, { mode: "ask" }),
            evaluateCommand("pnpm build", GLOBAL),
        );
    });

    it("always carries a risk and reports channel-sourced verdicts", () => {
        const ev = evaluateCommandForImWorkspace("cat f", GLOBAL, {
            mode: "auto",
            allow: ["ls"],
        });
        assert.ok(ev.risk);
        assert.equal(ev.source, "channel");
    });
});
