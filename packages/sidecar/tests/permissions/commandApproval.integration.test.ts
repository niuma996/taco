import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateCommand } from "../../src/permissions/commandPolicy.ts";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";

const manual = { mode: "ask" as const, allow: [], deny: [] };
describe("combined shell approval policy", () => {
    it("uses the deny-first decision table for every risk", () => {
        for (const command of ["git diff", "pnpm build", "git checkout main"]) {
            assert.equal(
                evaluateCommand(command, { ...manual, mode: "auto" }).behavior,
                "allow",
                command,
            );
            const denied = evaluateCommand(command, {
                ...manual,
                mode: "auto",
                allow: ["*"],
                deny: [command],
            });
            assert.equal(denied.behavior, "ask", command);
            assert.equal(denied.matchedList, "deny", command);
            assert.equal(
                evaluateCommand(command, { ...manual, allow: [command] }).behavior,
                "allow",
                command,
            );
        }
        // Built-in denylist: neither auto mode nor an allow rule passes these.
        for (const command of ["git push origin main", "rm -rf build"]) {
            for (const config of [
                { ...manual, mode: "auto" as const },
                { ...manual, allow: [command] },
                { ...manual, mode: "auto" as const, allow: ["*"] },
            ]) {
                const result = evaluateCommand(command, config);
                assert.equal(result.behavior, "ask", command);
                assert.equal(result.matchedList, "deny", command);
            }
        }
        assert.equal(evaluateCommand("git diff", manual).behavior, "allow");
        assert.equal(evaluateCommand("pnpm build", manual).behavior, "ask");
    });
    it("checks every command including quoted commands and directory changes", () => {
        const config = { ...manual, mode: "auto" as const, deny: ["git diff", "cd *"] };
        for (const command of [
            'git status && "git" "diff"',
            "cd . && git status",
            "git status | git diff",
        ]) {
            const result = evaluateCommand(command, config, { cwd: process.cwd() });
            assert.equal(result.behavior, "ask", command);
            assert.equal(result.matchedList, "deny", command);
        }
    });
    it("does not hide later privilege denials behind earlier approval", () => {
        for (const command of [
            "pnpm build && sudo ls",
            "echo $(pwd); sudo ls",
            "git diff > out; sudo ls",
        ]) {
            assert.equal(evaluateCommand(command, manual).behavior, "deny", command);
        }
    });
    it("tracks relative cd chains and rejects symlink escapes", () => {
        const base = mkdtempSync(join(tmpdir(), "taco-approval-"));
        const root = join(base, "root");
        const outside = join(base, "outside");
        mkdirSync(join(root, "a", "b"), { recursive: true });
        mkdirSync(outside);
        symlinkSync(outside, join(root, "escape"), "dir");
        try {
            const context = { cwd: root };
            assert.equal(
                evaluateCommand("cd a && cd b && git diff", manual, context).behavior,
                "allow",
            );
            assert.equal(
                evaluateCommand("cd a && cd ../.. && git diff", manual, context).behavior,
                "ask",
            );
            assert.equal(evaluateCommand("cd escape && git diff", manual, context).behavior, "ask");
            assert.equal(
                evaluateCommand(`cd "${outside}" && git diff`, manual, {
                    ...context,
                    allowedRoots: [outside],
                }).behavior,
                "allow",
            );
            assert.equal(evaluateCommand("cd .; git diff", manual, context).behavior, "allow");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
    it("keeps unknown syntax subject to approval", () => {
        for (const command of ["echo $(pwd)", "git diff &&", "if true; then git diff; fi"]) {
            assert.equal(
                evaluateCommand(command, { ...manual, mode: "auto" }).behavior,
                "ask",
                command,
            );
        }
    });
    it("isolates readonly execution from global automatic mode", async () => {
        const broker = new PermissionBroker(() => ({ mode: "auto", allow: ["*"], deny: [] }), {
            readOnly: true,
        });
        for (const command of [
            "touch output",
            "git checkout main",
            "find . -delete",
            "git diff > out",
        ]) {
            const decision = await broker.evaluateAndRequest({
                sessionId: "s",
                toolCallId: "t",
                command,
            });
            assert.equal(decision.approved, false, command);
            assert.equal(decision.evaluation.behavior, "deny", command);
        }
    });
    it("restricts blacklist approvals to once despite forged session scope", async () => {
        const broker = new PermissionBroker(() => ({ ...manual, mode: "auto", deny: ["pnpm *"] }), {
            requestTimeoutMs: 100,
        });
        broker.on("requested", (request) => broker.resolve(request.requestId, true, "session"));
        const result = await broker.evaluateAndRequest({
            sessionId: "s",
            toolCallId: "t",
            command: "pnpm build",
        });
        assert.equal(result.approved, true);
        assert.equal(result.scope, "once");
    });
});
