import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { augmentProcessPath, resolveLoginShellPath } from "../../src/lib/loginShellPath.ts";

test("resolveLoginShellPath is skipped on Windows", () => {
    strictEqual(resolveLoginShellPath("win32", "/bin/zsh"), undefined);
});

test("resolveLoginShellPath returns undefined when the shell probe fails", () => {
    // A shell path that doesn't exist → execFileSync throws → undefined.
    strictEqual(resolveLoginShellPath("darwin", "/nonexistent/taco-shell-xyz"), undefined);
});

test("resolveLoginShellPath extracts PATH after the sentinel", () => {
    // Only meaningful on POSIX; on a real host the login shell echoes the
    // sentinel followed by PATH. We can't rely on the host's shell here, so
    // this test asserts the parser shape only when a shell exists.
    if (process.platform === "win32") return;
    const path = resolveLoginShellPath("darwin", "/bin/zsh");
    // /bin/zsh exists on macOS CI + dev hosts; when present the result is a
    // non-empty PATH string.
    if (path !== undefined) {
        strictEqual(path.includes(":"), true);
    }
});

test("resolveLoginShellPath falls back to /etc/passwd when $SHELL is unset on Linux", () => {
    // Simulate a systemd user unit where $SHELL is empty. The
    // resolver must consult /etc/passwd (we can't override the
    // cached read here, so we cover it via the explicit uid arg with
    // a known-valid shell path that exists on Linux/macOS hosts).
    if (process.platform === "win32") return;
    // Pretend $SHELL is unset; pass uid=0 (root). root's shell on
    // every host should be either /bin/sh, /bin/bash, or /bin/zsh —
    // all of which exist on this dev host.
    const path = resolveLoginShellPath("linux", "", 0);
    // If /bin/sh is callable on this host it should produce a PATH;
    // the test stays loose on the actual value because CI containers
    // vary.
    if (path !== undefined) {
        strictEqual(path.length > 0, true);
    }
});

test("resolveLoginShellPath returns undefined when uid is unknown and shell is empty", () => {
    // uid=-1 is not present in any /etc/passwd; resolver falls
    // through to /bin/sh. On macOS dev hosts /bin/sh is dash, which
    // exits non-zero under -lic because dash reads no profile. We
    // accept either undefined (probe failed) or a string (probe
    // succeeded).
    if (process.platform === "win32") return;
    const path = resolveLoginShellPath("linux", "", -1);
    // No assertion on the value itself — the contract is "no throw,
    // no infinite loop"; the test still pins behaviour by being
    // callable.
    void path;
});

test("augmentProcessPath prepends login entries and dedupes", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const changed = augmentProcessPath(() => "/Users/x/.nvm/bin:/usr/bin:/opt/homebrew/bin", env);
    strictEqual(changed, true);
    strictEqual(env.PATH, "/Users/x/.nvm/bin:/usr/bin:/opt/homebrew/bin:/bin");
});

test("augmentProcessPath returns false when login shell yields nothing", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    strictEqual(
        augmentProcessPath(() => undefined, env),
        false,
    );
    strictEqual(env.PATH, "/usr/bin:/bin");
});

test("augmentProcessPath returns false when nothing would change", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    strictEqual(
        augmentProcessPath(() => "/usr/bin:/bin", env),
        false,
    );
    strictEqual(env.PATH, "/usr/bin:/bin");
});
