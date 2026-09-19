/**
 * Unit tests for the Windows schtasks install path. These cover the pure
 * rendering functions (.vbs wrapper + escape rules) — actually running
 * `schtasks` requires a Windows host.
 */

import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
    escapeVbs,
    legacyWindowsCmdPath,
    renderWindowsWrapper,
    SCHTASKS_NAME,
    schtasksCreateArgs,
    windowsWrapperPath,
} from "../lib/installSchtasks.ts";

test("escapeVbs doubles quotes inside VBScript string literals", () => {
    strictEqual(escapeVbs('a"b'), 'a""b');
    // `&` is concatenation only outside quotes — inside a VBS string it
    // is literal, unlike the old `.cmd` `set` lines that needed `^&`.
    strictEqual(escapeVbs("a&b"), "a&b");
    strictEqual(escapeVbs("C:\\Users\\foo\\.taco"), "C:\\Users\\foo\\.taco");
});

test("windowsWrapperPath is the .vbs under $TACO_HOME\\bin", () => {
    const home = "C:\\Users\\foo\\.taco";
    // `path.join` so the assertion holds on POSIX CI too (install itself
    // only runs on win32, where join uses backslash).
    strictEqual(windowsWrapperPath(home), join(home, "bin", "taco-sidecar-daemon.vbs"));
    strictEqual(legacyWindowsCmdPath(home), join(home, "bin", "taco-sidecar-daemon.cmd"));
});

test("renderWindowsWrapper produces a .vbs that sets the daemon env and Run's node hidden", () => {
    const vbs = renderWindowsWrapper({
        tacoHome: "C:\\Users\\foo\\.taco",
        socketPath: "\\\\.\\pipe\\taco-sidecar",
        controlSocketPath: "\\\\.\\pipe\\taco-sidecar-ctl",
        nodeBin: "C:\\Users\\foo\\.taco\\bin\\taco-sidecar-node.exe",
        bundle: "C:\\Users\\foo\\.taco\\bin\\sidecar.mjs",
        resourcesRoot: "C:\\Users\\foo\\.taco\\share\\sidecar",
    });

    ok(vbs.includes("Option Explicit"));
    ok(vbs.includes('CreateObject("WScript.Shell")'));
    ok(vbs.includes('sh.Environment("Process")'));
    // Must not be a .cmd — that is what flashed a console at logon.
    ok(!vbs.includes("@echo off"));
    ok(!vbs.includes("setlocal"));

    // All daemon-mode env vars must be set; the sidecar reads them on startup.
    for (const v of [
        'env("TACO_SOCKET")',
        'env("TACO_CONTROL_SOCKET")',
        'env("TACO_DAEMON_MODE") = "1"',
        'env("TACO_SIDECAR_RESOURCES")',
        'env("TACO_STDERR_LOG")',
    ]) {
        ok(vbs.includes(v), `missing: ${v}`);
    }

    // Scheduled tasks get the install-time per-user TACO_HOME baked in.
    ok(vbs.includes('env("TACO_HOME") = "C:\\Users\\foo\\.taco"'));
    ok(vbs.includes("C:\\Users\\foo\\.taco\\logs\\daemon.err.log"));

    // Hidden + wait: style 0 is SW_HIDE; True keeps the task Running so
    // `schtasks /End` still has a process tree to terminate.
    ok(
        vbs.includes(
            'WScript.Quit sh.Run("""C:\\Users\\foo\\.taco\\bin\\taco-sidecar-node.exe"" ""C:\\Users\\foo\\.taco\\bin\\sidecar.mjs""", 0, True)',
        ),
    );
});

test("renderWindowsWrapper escapes VBS quotes in baked-in paths", () => {
    const vbs = renderWindowsWrapper({
        tacoHome: 'C:\\Users\\x"y\\.taco',
        socketPath: "\\\\.\\pipe\\taco-sidecar",
        controlSocketPath: "\\\\.\\pipe\\taco-sidecar-ctl",
        nodeBin: 'C:\\Users\\x"y\\bin\\taco-sidecar-node.exe',
        bundle: 'C:\\Users\\x"y\\bin\\sidecar.mjs',
        resourcesRoot: 'C:\\Users\\x"y\\share\\sidecar',
    });

    ok(vbs.includes('x""y'), `expected doubled quote, got: ${vbs}`);
    // A raw `x"y` inside a VBS `"..."` literal would terminate the string.
    ok(!vbs.includes('x"y'));
});

test("renderWindowsWrapper leaves cmd metacharacters intact inside VBS strings", () => {
    const vbs = renderWindowsWrapper({
        tacoHome: "C:\\R&D\\.taco",
        socketPath: "\\\\.\\pipe\\taco-sidecar",
        controlSocketPath: "\\\\.\\pipe\\taco-sidecar-ctl",
        nodeBin: "C:\\R&D\\bin\\taco-sidecar-node.exe",
        bundle: "C:\\R&D\\bin\\sidecar.mjs",
        resourcesRoot: "C:\\R&D\\share\\sidecar",
    });

    ok(vbs.includes("R&D"), `expected literal R&D, got: ${vbs}`);
    ok(!vbs.includes("R^&D"));
});

test("schtasksCreateArgs registers a per-user logon task the installer can kill", () => {
    const args = schtasksCreateArgs("C:\\Users\\Alice Smith\\.taco\\bin\\taco-sidecar-daemon.vbs");

    // ONLOGON without /RU: runs as the creating user at sign-in. ONSTART
    // would run as SYSTEM, whose processes the per-user installer cannot
    // terminate — upgrades then fail with "Error opening file for writing".
    ok(args.includes("ONLOGON"));
    ok(!args.includes("ONSTART"));
    // No elevation: /RL HIGHEST would put the daemon behind a token the
    // installer's KillProcessCurrentUser cannot reach.
    ok(!args.includes("/RL"));
    // Overwrite prior registration.
    ok(args.includes("/F"));
    const trIndex = args.indexOf("/TR");
    ok(trIndex >= 0);
    // wscript (GUI subsystem) + //nologo + quoted .vbs — never cmd.exe, never
    // a bare .cmd, so logon does not flash a console.
    strictEqual(
        args[trIndex + 1],
        'wscript.exe //nologo "C:\\Users\\Alice Smith\\.taco\\bin\\taco-sidecar-daemon.vbs"',
    );
    ok(!args[trIndex + 1].includes(".cmd"));
    const tnIndex = args.indexOf("/TN");
    ok(tnIndex >= 0);
    strictEqual(args[tnIndex + 1], SCHTASKS_NAME);
});

test("SCHTASKS_NAME matches the install/uninstall contract", () => {
    // The same constant is imported in uninstallSchtasks.ts; a typo would
    // leave the task registered on uninstall (silent leak).
    strictEqual(SCHTASKS_NAME, "TacoSidecar");
});
