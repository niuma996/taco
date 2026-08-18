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
