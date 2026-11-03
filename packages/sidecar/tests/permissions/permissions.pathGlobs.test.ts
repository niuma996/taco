import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    evaluateCommand,
    evaluateCommandForImWorkspace,
    evaluateReadOnlyCommand,
} from "../../src/permissions/commandPolicy.ts";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import { parseShellCommand } from "../../src/permissions/shellParser.ts";

const auto = { mode: "auto" as const, allow: [], deny: [] };
const context = { cwd: process.cwd(), language: "bash" as const };

describe("local automatic ls path globs", () => {
    it("allows prefixed path patterns without executing or expanding them", () => {
        for (const command of [
            "ls -1 src/*.ts",
            "ls -1 src/runtime src/runtime/*/",
            "ls tests/*/ -d",
            "ls ./src/file?.ts",
            "ls ./src/[ab]*.ts",
            "ls ./*",
            "ls ./-*/file",
            "ls -- *",
            "ls -1 /nonexistent-directory/*.ts",
            "ls -1 src/* | head -50",
            "cd . && ls -1 src/*.ts && ls tests/*/ -d",
        ]) {
            const result = evaluateCommand(command, auto, context);
            assert.equal(result.behavior, "allow", command);
            assert.equal(result.risk, "readOnly", command);
        }
    });

    it("keeps executable, option, and unsupported expansions approval-gated", () => {
        for (const command of [
            "ls *",
            "ls -l *",
            "ls -D -- *",
            "ls -lD -- *",
            "ls -I src/*",
            "ls --ignore=src/*",
            "ls --sort src/*",
            "ls --unknown src/*",
            "ls src/{a,b}/*",
            "ls src/@(a|b)/*",
            "ls src/**/file",
            "./tools/* --version",
            "cat src/*",
            "sort *",
            "tar *",
            "find src/* -delete",
            'ls "$d"/*',
            "ls $(pwd)/*",
            "ls `pwd`/*",
            "ls <(pwd)",
            'for d in src/*/; do ls "$d"; done',
            "ls src/* > listing.txt",
            "ls src/* 2>/dev/null",
            "FOO=bar ls src/*",
            "ls ~/src/*",
            "ls ~/src src/*",
            "ls src/* &",
        ]) {
            const result = evaluateCommand(command, { ...auto, allow: ["*"] }, context);
            assert.equal(result.behavior, "ask", command);
            assert.equal(result.persistentAllowed, false, command);
        }
    });

    it("does not let a safe glob mask dangerous siblings", () => {
        assert.equal(evaluateCommand("ls src/* && rm -rf build", auto, context).behavior, "ask");
        assert.equal(evaluateCommand("ls src/* && sudo whoami", auto, context).behavior, "deny");
        assert.equal(evaluateCommand("ls src/* | xargs sh", auto, context).behavior, "ask");
    });

    it("retains exact-approval restrictions on nested remote execution", () => {
        for (const command of ['ssh host "ls src/*"', "docker exec c ls src/*"]) {
            const result = evaluateCommand(command, { ...auto, allow: [command] }, context);
            assert.equal(result.behavior, "ask", command);
            assert.equal(result.persistentAllowed, false, command);
        }
    });

    it("preserves deny rules even when a path is hidden by a glob", () => {
        for (const deny of [["ls *"], ["ls src/private.ts"], ["ls src/private*"], ["git push *"]]) {
            const result = evaluateCommand("ls src/*.ts", { ...auto, allow: ["*"], deny }, context);
            assert.equal(result.behavior, "ask", deny.join());
        }
        const denied = evaluateCommand("ls src/*", { ...auto, deny: ["ls *"] }, context);
        assert.equal(denied.matchedList, "deny");
    });

    it("does not change manual, IM, read-only, or PowerShell evaluation", () => {
        const command = "ls src/*";
        assert.equal(
            evaluateCommand(command, { ...auto, mode: "ask", allow: ["*"] }, context).behavior,
            "ask",
        );
        assert.equal(
            evaluateCommandForImWorkspace(command, auto, { mode: "auto", allow: ["*"] }, context)
                .behavior,
            "ask",
        );
        assert.equal(evaluateReadOnlyCommand(command, context).behavior, "deny");
        assert.equal(
            evaluateCommand(command, auto, { ...context, language: "powershell" }).behavior,
            "allow",
        );
        // PowerShell's existing wildcard behavior is unchanged; Bash-only logic must not reinterpret it.
        assert.equal(parseShellCommand(command, "bash").complete, false);
    });

    it("retains quoted and escaped stars as literal arguments", () => {
        for (const command of ['ls "src/*.ts"', "ls 'src/*.ts'", String.raw`ls src/\*.ts`]) {
            assert.equal(parseShellCommand(command, "bash").complete, true, command);
            assert.equal(evaluateCommand(command, auto, context).behavior, "allow", command);
        }
        for (const command of [
            'ls "~/src" src/*',
            String.raw`ls \~/src src/*`,
            "ls HEAD~1 src/*",
        ]) {
            assert.equal(evaluateCommand(command, auto, context).behavior, "allow", command);
        }
    });

    it("attributes Bash redirects to the command receiving them", () => {
        for (const command of [
            "ls src/* && cat file 2>/dev/null",
            "ls src/* | cat > listing.txt",
        ]) {
            const parsed = parseShellCommand(command, "bash");
            assert.equal(parsed.nodes[0].redirects, undefined, command);
            assert.equal(parsed.nodes[1].redirects, true, command);
        }
        assert.equal(parseShellCommand("ls src/* > listing.txt", "bash").nodes[0].redirects, true);
        const result = evaluateCommand(
            "grep foo file 2>/dev/null | head && ls tests/*/ -d | head && cat file 2>/dev/null | head",
            auto,
            context,
        );
        assert.equal(result.behavior, "allow");
        assert.equal(result.risk, "workspaceWrite");
    });

    it("retains argument expansion kinds without evaluating their values", () => {
        const parsed = parseShellCommand('ls src/* "$d" "$(pwd)" "literal*" src/{a,b}', "bash");
        assert.deepEqual(parsed.nodes[0].argumentKinds, [
            "literal",
            "glob",
            "variable",
            "substitution",
            "literal",
            "unsupported",
        ]);
    });

    it("reports the unresolved substitution rather than an earlier safe path glob", () => {
        const result = evaluateCommand('ls src/* && echo "$(pwd)"', auto, context);
        assert.equal(result.behavior, "ask");
        assert.equal(result.reason, "command substitution requires approval");
        assert.equal(result.triggeringCommand, 'echo "$(pwd)"');
    });

    it("does not prompt locally but continues refusing approvals in IM and read-only brokers", async () => {
        const args = { sessionId: "s1", toolCallId: "t1", command: "ls src/*", ...context };
        const local = new PermissionBroker(() => auto, { hasApprover: () => false });
        assert.equal((await local.evaluateAndRequest(args)).approved, true);
        const im = new PermissionBroker(() => auto, { refuseApprovals: true });
        const decision = await im.evaluateAndRequest(args);
        assert.equal(decision.approved, false);
        assert.equal(decision.denialReason, "im_channel");
        const readOnly = new PermissionBroker(() => auto, { readOnly: true });
        assert.equal((await readOnly.evaluateAndRequest(args)).approved, false);
    });
});
