import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateCommand } from "../../src/permissions/commandPolicy.ts";
import { parseShellCommand } from "../../src/permissions/shellParser.ts";

const auto = { mode: "auto" as const, allow: [], deny: [] };
describe("approval review regressions", () => {
    it("preserves ordinary backslashes inside Bash double quotes and matches deny rules", () => {
        const command = String.raw`git show "a\zb"`;
        assert.deepEqual(parseShellCommand(command, "bash").nodes[0]?.argv, [
            "git",
            "show",
            String.raw`a\zb`,
        ]);
        assert.equal(
            evaluateCommand(command, { ...auto, deny: [String.raw`git show a\zb`] }).matchedList,
            "deny",
        );
    });
    it("supports exact approval of static executable paths without wildcard approval", () => {
        for (const command of [
            "./gradlew build -x test",
            "node_modules/.bin/tsc --noEmit",
            '"/some path/tool" build',
        ]) {
            assert.equal(parseShellCommand(command, "bash").complete, true, command);
            assert.equal(
                evaluateCommand(command, { ...auto, allow: [command] }).behavior,
                "allow",
                command,
            );
            assert.equal(
                evaluateCommand(command, { ...auto, allow: ["*"] }).behavior,
                "ask",
                command,
            );
            assert.equal(
                evaluateCommand(command, { ...auto, allow: [command], deny: [command] })
                    .matchedList,
                "deny",
                command,
            );
        }
    });
    it("rejects privilege escalation inside remote and container execution", () => {
        for (const command of [
            "ssh host sudo ls",
            'ssh -p 22 host "sudo ls"',
            "docker exec -u root c sudo ls",
            "podman exec c sudo ls",
            "kubectl exec pod -- chmod -R 777 /x",
            "git -c alias.pwn='!sudo ls' pwn",
            "/usr/bin/sudo ls",
        ]) {
            assert.equal(evaluateCommand(command, auto).behavior, "deny", command);
        }
    });
    it("requires exact approval for opaque execution while retaining inner deny floors", () => {
        for (const command of [
            "ssh host ls",
            "docker exec c ls",
            "kubectl exec pod -- ls",
            "git -c alias.pwn='!touch /tmp/pwn' pwn",
            "git --config-env=alias.pwn=MY_ALIAS pwn",
        ]) {
            assert.equal(
                evaluateCommand(command, { ...auto, allow: ["*"] }).behavior,
                "ask",
                command,
            );
            assert.equal(
                evaluateCommand(command, { ...auto, allow: [command] }).behavior,
                "allow",
                command,
            );
        }
        assert.equal(
            evaluateCommand('ssh host "rm -rf build"', {
                ...auto,
                allow: ['ssh host "rm -rf build"'],
            }).matchedList,
            "deny",
        );
        assert.equal(evaluateCommand("git -c color.ui=false diff", auto).behavior, "allow");
        assert.equal(evaluateCommand('git commit -m "sudo fix"', auto).behavior, "allow");
    });
    it("marks unsupported syntax as ineligible for persistent approval", () => {
        for (const command of ["echo $(pwd)", "git diff &&", 'bash -c "echo hi"']) {
            assert.equal(
                evaluateCommand(command, { ...auto, allow: [command] }).persistentAllowed,
                false,
                command,
            );
        }
    });
});

it("does not store ineffective session approvals for dynamic syntax", async () => {
    const { PermissionBroker } = await import("../../src/permissions/permissionBroker.ts");
    const broker = new PermissionBroker(() => auto);
    let requests = 0;
    broker.on("requested", (request) => {
        requests++;
        broker.resolve(request.requestId, true, "session");
    });
    for (let i = 0; i < 2; i++) {
        const decision = await broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "echo $(pwd)",
        });
        assert.equal(decision.scope, "once");
    }
    assert.equal(requests, 2);
});

it("does not allow exact authorization to cross wrapper or inner blacklist boundaries", () => {
    for (const command of [
        '/bin/bash -c "echo hi"',
        'ssh host "echo $(pwd)"',
        "ssh host 'if true; then ls; fi'",
    ]) {
        const evaluation = evaluateCommand(command, { ...auto, allow: [command] });
        assert.equal(evaluation.behavior, "ask", command);
        assert.equal(evaluation.persistentAllowed, false, command);
    }
    assert.equal(
        evaluateCommand("ssh host ls", { ...auto, allow: ["ssh host ls"], deny: ["ls"] })
            .matchedList,
        "deny",
    );
});

it("retains built-in risk floors for absolute Git executables", () => {
    const command = "/usr/bin/git -C . push origin main";
    assert.equal(evaluateCommand(command, { ...auto, allow: [command] }).matchedList, "deny");
});

it("persists exact static path commands whose quoted arguments contain literal stars", () => {
    const command = "./tool '*.txt'";
    assert.equal(evaluateCommand(command, { ...auto, allow: [command] }).behavior, "allow");
});
it("supports static PowerShell executable paths", () => {
    for (const command of [String.raw`.\build.ps1 -Check`, String.raw`C:\tools\build.exe check`]) {
        assert.equal(
            evaluateCommand(command, { ...auto, allow: [command] }, { language: "powershell" })
                .behavior,
            "allow",
        );
    }
});

it("checks every configured executable Git alias and bounds nested analysis", () => {
    const command = "git -c alias.bad='!sudo ls' -c alias.other='!echo hi' bad";
    assert.equal(evaluateCommand(command, auto).behavior, "deny");
    const nested = `${"ssh host ".repeat(10)}ls`;
    assert.equal(evaluateCommand(nested, { ...auto, allow: [nested] }).behavior, "ask");
    assert.equal(evaluateCommand(nested, { ...auto, allow: [nested] }).persistentAllowed, false);
});

it("applies named executable deny rules to explicit executable paths", () => {
    const command = "/usr/bin/git diff";
    assert.equal(
        evaluateCommand(command, { ...auto, allow: [command], deny: ["git diff"] }).matchedList,
        "deny",
    );
});

it("does not persist container execution when options obscure the command boundary", () => {
    for (const command of [
        "docker run --hostname h image sudo ls",
        "docker run --gpus all image sudo ls",
        "podman run --future-option value image sudo ls",
    ]) {
        const evaluation = evaluateCommand(command, { ...auto, allow: [command] });
        assert.notEqual(evaluation.behavior, "allow", command);
    }
});

it("checks an explicit container entrypoint for privilege escalation", () => {
    for (const command of [
        "docker run --entrypoint sudo image ls",
        "docker run --entrypoint=/usr/bin/sudo image ls",
    ]) {
        assert.equal(evaluateCommand(command, { ...auto, allow: [command] }).behavior, "deny");
    }
});

it("keeps SSH combined options from hiding the remote executable", () => {
    const command = "ssh -vp 2222 host sudo ls";
    assert.equal(evaluateCommand(command, { ...auto, allow: [command] }).behavior, "deny");
    const blocked = "ssh -vp 2222 host blocked";
    assert.equal(
        evaluateCommand(blocked, { ...auto, allow: [blocked], deny: ["blocked"] }).matchedList,
        "deny",
    );
    const unknown = "ssh --future-option value host ls";
    const evaluation = evaluateCommand(unknown, { ...auto, allow: [unknown] });
    assert.equal(evaluation.behavior, "ask");
    assert.equal(evaluation.persistentAllowed, false);
});

it("requires once-only approval for SSH options that execute commands", () => {
    for (const command of [
        'ssh -o ProxyCommand="sudo ls" host ls',
        'ssh -oProxyCommand="blocked" host ls',
        'ssh -vo "LocalCommand blocked" host ls',
        "ssh -o RemoteCommand=blocked host",
        "ssh -o KnownHostsCommand=blocked host ls",
    ]) {
        const evaluation = evaluateCommand(command, { ...auto, allow: [command] });
        assert.equal(evaluation.behavior, "ask", command);
        assert.equal(evaluation.persistentAllowed, false, command);
    }
});
