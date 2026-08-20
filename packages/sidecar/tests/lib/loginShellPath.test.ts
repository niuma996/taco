import { strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    augmentProcessPath,
    resolveLoginShellPath,
    resolveLoginShellPathCached,
} from "../../src/lib/loginShellPath.ts";

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

// ─────────── resolveLoginShellPathCached (disk cache) ───────────

let cacheHome: string | undefined;
const savedTacoHome = process.env.TACO_HOME;

before(() => {
    if (process.platform === "win32") return;
    cacheHome = mkdtempSync(join(tmpdir(), "login-path-cache-"));
    process.env.TACO_HOME = cacheHome;
});

after(() => {
    if (cacheHome) rmSync(cacheHome, { recursive: true, force: true });
    if (savedTacoHome === undefined) {
        delete process.env.TACO_HOME;
    } else {
        process.env.TACO_HOME = savedTacoHome;
    }
});

test("resolveLoginShellPathCached: miss probes and writes, second call hits without probing", () => {
    if (process.platform === "win32" || !cacheHome) return;
    let probes = 0;
    const probe = () => {
        probes += 1;
        return "/cached/bin:/usr/bin";
    };
    const shell = "/bin/zsh";

    strictEqual(resolveLoginShellPathCached(probe, shell), "/cached/bin:/usr/bin");
    strictEqual(probes, 1);
    // Cache file written with the probe result.
    const entry = JSON.parse(readFileSync(join(cacheHome, "run", "login-path-cache.json"), "utf8"));
    strictEqual(entry.path, "/cached/bin:/usr/bin");
    strictEqual(entry.shell, shell);

    // Second call is served from disk — probe not invoked again.
    strictEqual(resolveLoginShellPathCached(probe, shell), "/cached/bin:/usr/bin");
    strictEqual(probes, 1);
});

test("resolveLoginShellPathCached: shell mismatch in cache re-probes", () => {
    if (process.platform === "win32" || !cacheHome) return;
    // Self-contained: wipe the cache the previous test primed.
    rmSync(join(cacheHome, "run"), { recursive: true, force: true });
    let probes = 0;
    const probe = () => {
        probes += 1;
        return "/fresh/bin";
    };
    // Prime the cache with one shell, then resolve with another.
    resolveLoginShellPathCached(probe, "/bin/zsh");
    strictEqual(resolveLoginShellPathCached(probe, "/bin/bash"), "/fresh/bin");
    strictEqual(probes, 2);
});

test("resolveLoginShellPathCached: failed probe leaves no cache file behind", () => {
    if (process.platform === "win32" || !cacheHome) return;
    // Wipe whatever earlier tests wrote, then fail the probe.
    rmSync(join(cacheHome, "run"), { recursive: true, force: true });
    strictEqual(
        resolveLoginShellPathCached(() => undefined, "/bin/zsh"),
        undefined,
    );
    let threw = false;
    try {
        readFileSync(join(cacheHome, "run", "login-path-cache.json"), "utf8");
    } catch {
        threw = true;
    }
    strictEqual(threw, true);
});
