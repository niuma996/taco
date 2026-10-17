import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseShellCommand } from "../../src/permissions/shellParser.ts";

describe("Tree-sitter shell parsing", () => {
    for (const language of ["bash", "powershell"] as const) {
        it(`${language}: decodes arguments and connector structure`, () => {
            const result = parseShellCommand('cd "a b" && git "diff"; git status | head', language);
            assert.equal(result.complete, true, result.reason);
            assert.deepEqual(
                result.nodes.map((node) => node.argv),
                [["cd", "a b"], ["git", "diff"], ["git", "status"], ["head"]],
            );
            assert.deepEqual(
                result.nodes.map((node) => node.operator),
                [undefined, "&&", ";", "|"],
            );
            assert.equal(result.nodes[0].cwd, "a b");
            for (const node of result.nodes)
                assert.equal(
                    'cd "a b" && git "diff"; git status | head'.slice(node.start, node.end),
                    node.text,
                );
        });
        it(`${language}: literal single-quoted dollar signs stay literal`, () => {
            const result = parseShellCommand("git show '$HOME'", language);
            assert.equal(result.complete, true, result.reason);
            assert.deepEqual(result.nodes[0].argv, ["git", "show", "$HOME"]);
            assert.equal(result.nodes[0].dynamic, false);
        });
        it(`${language}: exposes commands inside substitutions conservatively`, () => {
            const result = parseShellCommand("git show $(sudo whoami)", language);
            assert.equal(result.complete, false);
            assert.ok(result.nodes.some((node) => node.argv[0] === "sudo"));
        });
        it(`${language}: marks redirects rather than hiding their side effects`, () => {
            const result = parseShellCommand("git diff > out", language);
            assert.equal(result.nodes[0].redirects, true);
            assert.deepEqual(result.nodes[0].argv, ["git", "diff"]);
        });
        it(`${language}: malformed syntax cannot auto-allow`, () => {
            assert.equal(parseShellCommand('git "diff', language).complete, false);
        });
        it(`${language}: comments do not become commands and newlines remain separators`, () => {
            const result = parseShellCommand("git status # status\ngit diff", language);
            assert.equal(result.complete, true, result.reason);
            assert.deepEqual(
                result.nodes.map((node) => node.argv),
                [
                    ["git", "status"],
                    ["git", "diff"],
                ],
            );
            assert.equal(result.nodes[1].operator, "\n");
        });
    }
    it("uses execution platform default rather than guessing from argument text", () => {
        assert.equal(
            parseShellCommand("echo Set-Location").language,
            process.platform === "win32" ? "powershell" : "bash",
        );
    });
    it("decodes Bash concatenation and escaped spaces", () => {
        const result = parseShellCommand("git d'if'f a\\ b", "bash");
        assert.equal(result.complete, true, result.reason);
        assert.deepEqual(result.nodes[0].argv, ["git", "diff", "a b"]);
    });
    it("extracts the PowerShell literal location parameter", () => {
        const result = parseShellCommand(
            "Set-Location -LiteralPath 'C:\\a b'; git diff",
            "powershell",
        );
        assert.equal(result.complete, true, result.reason);
        assert.equal(result.nodes[0].cwd, "C:\\a b");
    });
    it("rejects unsupported shell blocks while retaining nested privilege commands", () => {
        for (const [command, language] of [
            ["if true; then sudo ls; fi", "bash"],
            ["if ($true) { sudo ls }", "powershell"],
        ] as const) {
            const result = parseShellCommand(command, language);
            assert.equal(result.complete, false);
            assert.ok(result.nodes.some((node) => node.argv[0] === "sudo"));
        }
    });
    it("retains PowerShell invocation target for privilege checks", () => {
        const result = parseShellCommand("& 'sudo' ls", "powershell");
        assert.equal(result.complete, false);
        assert.deepEqual(result.nodes[0].argv, ["sudo", "ls"]);
    });
    it("keeps Unicode source ranges accurate", () => {
        const command = "cd '目录' && git diff";
        const result = parseShellCommand(command, "bash");
        assert.equal(result.complete, true, result.reason);
        assert.deepEqual(
            result.nodes.map((node) => command.slice(node.start, node.end)),
            ["cd '目录'", "git diff"],
        );
    });
    it("does not lose privilege commands inside redirected expressions", () => {
        for (const language of ["bash", "powershell"] as const) {
            const result = parseShellCommand("git diff > $(sudo whoami)", language);
            assert.ok(result.nodes.some((node) => node.argv[0] === "sudo"));
            assert.equal(result.nodes[0].redirects, true);
        }
    });
    it("rejects backgrounding, assignments, and subshells conservatively", () => {
        for (const command of [
            "git diff &",
            "FOO=bar git diff",
            "(cd a && git diff)",
            "for i in a; do git diff; done",
        ]) {
            assert.equal(parseShellCommand(command, "bash").complete, false, command);
        }
    });
    it("bounds oversized command input", () => {
        assert.equal(parseShellCommand("x".repeat(131_073), "bash").complete, false);
    });
});
