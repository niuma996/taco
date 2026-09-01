/**
 * loginShellPath.ts — recover the user's interactive PATH for a daemon
 * launched with a minimal one.
 *
 * launchd (and Tauri-spawned GUI processes on macOS) start with
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Anything the user installed into a
 * version-manager or package-manager bin dir — nvm (`~/.nvm/versions/node/…`),
 * Homebrew, `~/.local/bin`, etc. — is invisible to the sidecar, so an agent
 * shell call like `mmx …` fails with `command not found` (exit 127) even
 * though the binary exists. That was the root cause of the scheduler's
 * mmx search job looping on `command not found`.
 *
 * We re-derive the real PATH by asking the user's login shell. `-lic`
 * forces login+interactive so both `.zprofile`/`.zshrc` (nvm) and
 * `/etc/paths` (path_helper) run — a non-interactive `-c` skips `.zshrc`,
 * which is where most PATH setup lives.
 *
 * Shell-resolution fallback chain (Linux services were the trigger —
 * systemd user units and dbus-activated daemons don't always export
 * `SHELL`):
 *   1. `$SHELL` when non-empty (the macOS / interactive Linux case).
 *   2. The user's login shell as recorded in `/etc/passwd`
 *      (`getent passwd $UID`) — this is the authoritative place
 *      `chsh(1)` writes to. macOS DirectoryServices has its own
 *      command (`dscl . -read /Users/<user> UserShell`); we don't try
 *      it because macOS always exports `$SHELL`, so the chain never
 *      reaches step 2 there.
 *   3. `/bin/sh` (POSIX-required to exist; last-resort).
 *
 * Failure modes are all swallowed: a missing/hung shell just means we keep
 * the inherited PATH. The probe result is cached under TACO_HOME keyed on
 * (shell, rc-file mtimes) — see resolveLoginShellPathCached — so steady-state
 * starts skip the shell spawn entirely.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";
import { scrubbedProcessEnv } from "../runtime/providerKeyStore.ts";

/** Marker that separates our echo from any MOTD / profile chatter the shell
 *  prints before running the command. We search for the last occurrence so a
 *  profile that echoes text keeps us honest. */
const SENTINEL = "__TACO_LOGIN_PATH__";

/** Cap the probe so a shell whose rc waits on input (or hangs) can't stall
 *  daemon startup. 1.5 s is generous for a `echo $PATH` round-trip. */
const PROBE_TIMEOUT_MS = 1500;

/** Find the user's login shell via the platform-appropriate path.
 *  See the module header for the fallback chain rationale. */
function resolveShell(
    shell: string | undefined,
    platform: NodeJS.Platform,
    uid: number | undefined,
): string {
    if (shell && shell.length > 0) return shell;
    // Passwd file lookup: works on Linux when $SHELL is unset (e.g.
    // systemd user services). We deliberately don't shell out to
    // `getent` — spawning a process just to read /etc/passwd is a
    // poor trade for a startup-time bootstrap.
    if (uid !== undefined && platform !== "win32") {
        const passwd = readPasswd();
        for (const line of passwd) {
            const parsed = parsePasswdLine(line);
            if (parsed && parsed.uid === uid) {
                return parsed.shell;
            }
        }
    }
    // POSIX-mandated last-resort shell — present on every Unix.
    return "/bin/sh";
}

/** Parse a single `/etc/passwd` line. Returns null for malformed lines
 *  rather than throwing — `/etc/passwd` has been stable for decades but
 *  NIS / LDAP replacements occasionally deliver non-standard entries. */
function parsePasswdLine(line: string): { uid: number; shell: string } | null {
    const parts = line.split(":");
    if (parts.length < 7) return null;
    const uidStr = parts[2];
    const shell = parts[6];
    if (!uidStr || !shell) return null;
    const uid = Number.parseInt(uidStr, 10);
    if (!Number.isFinite(uid)) return null;
    return { uid, shell };
}

let passwdCache: string[] | undefined;

/** Read /etc/passwd lazily. Cached after the first read because the
 *  daemon only needs this on a one-shot bootstrap. Errors are
 *  swallowed (returns []) — a missing or unreadable passwd file just
 *  means we fall back to /bin/sh, which is the right answer on a
 *  container that doesn't have one. */
function readPasswd(): string[] {
    if (passwdCache) return passwdCache;
    try {
        passwdCache = readFileSync("/etc/passwd", "utf8").split("\n");
    } catch {
        passwdCache = [];
    }
    return passwdCache;
}

/**
 * Run the user's login shell and return its PATH, or undefined when it can't
 * be determined. Skipped entirely on Windows — the problem is launchd/GUI
 * PATH stripping, which doesn't exist there.
 */
export function resolveLoginShellPath(
    platform: NodeJS.Platform = process.platform,
    shell: string | undefined = process.env.SHELL,
    uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | undefined {
    if (platform === "win32") return undefined;
    const resolvedShell = resolveShell(shell, platform, uid);
    let out: string;
    try {
        out = execFileSync(resolvedShell, ["-lic", `echo ${SENTINEL}$PATH`], {
            encoding: "utf8",
            timeout: PROBE_TIMEOUT_MS,
            // Discard the shell's stderr — interactive shells without a TTY
            // emit job-control / no-tty warnings that are noise here.
            stdio: ["ignore", "pipe", "ignore"],
            env: scrubbedProcessEnv(),
        });
    } catch {
        return undefined;
    }
    const idx = out.lastIndexOf(SENTINEL);
    if (idx === -1) return undefined;
    const path = out.slice(idx + SENTINEL.length).trim();
    return path.length > 0 ? path : undefined;
}

/**
 * Merge the login-shell PATH into `process.env.PATH`, login entries first so
 * user bin dirs win over the inherited minimal set. Inherited entries that
 * the login shell didn't produce are appended (deduped) so we never lose a
 * dir the launcher explicitly provided. Returns true when PATH changed.
 */
export function augmentProcessPath(
    resolve: () => string | undefined = resolveLoginShellPath,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const loginPath = resolve();
    if (!loginPath) return false;
    const inherited = env.PATH ?? "";
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const dir of [...loginPath.split(":"), ...inherited.split(":")]) {
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        merged.push(dir);
    }
    const next = merged.join(":");
    if (next === inherited) return false;
    env.PATH = next;
    return true;
}

// ─────────── disk cache for the probe result ───────────
//
// The probe spawns a login shell (up to PROBE_TIMEOUT_MS on pathological rc
// files) on every daemon start. The result only changes when the user edits
// a shell rc file or switches shells, so it is cached under TACO_HOME keyed
// on (resolved shell, max rc-file mtime). Any rc edit invalidates on the
// next start — the cache can never resurrect the stale-PATH bug this module
// exists to fix. Corrupt/missing cache is a plain miss (probe + rewrite).

/** Rc files across the common shells, stat'ed regardless of the active shell
 *  so a shell switch is covered by the shell key alone. /etc/paths and other
 *  system files are skipped: they change with OS updates, not user intent. */
const RC_FILES = [
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".bashrc",
] as const;

interface LoginPathCacheEntry {
    shell: string;
    stamp: number;
    path: string;
}

/** Max mtimeMs across existing rc files; 0 when none exist. */
function rcStamp(): number {
    let stamp = 0;
    const home = homedir();
    for (const f of RC_FILES) {
        try {
            const m = statSync(resolvePath(home, f)).mtimeMs;
            if (m > stamp) stamp = m;
        } catch {
            // not present — contributes nothing to the stamp
        }
    }
    return stamp;
}

function loginPathCacheFile(): string {
    return resolvePath(tacoHome(), "run", "login-path-cache.json");
}

/**
 * resolveLoginShellPath with a disk cache: on cache hit the shell spawn is
 * skipped entirely. Skipped on Windows like the raw probe. The probe is
 * injectable so tests can observe hit vs miss.
 */
export function resolveLoginShellPathCached(
    probe: () => string | undefined = resolveLoginShellPath,
    shell: string | undefined = process.env.SHELL,
    uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | undefined {
    if (process.platform === "win32") return undefined;
    const resolvedShell = resolveShell(shell, process.platform, uid);
    const file = loginPathCacheFile();
    const stamp = rcStamp();
    try {
        const entry = JSON.parse(readFileSync(file, "utf8")) as Partial<LoginPathCacheEntry>;
        if (
            entry.shell === resolvedShell &&
            entry.stamp === stamp &&
            typeof entry.path === "string" &&
            entry.path.length > 0
        ) {
            return entry.path;
        }
    } catch {
        // miss (missing / corrupt cache) — fall through to the probe
    }
    const path = probe();
    if (path !== undefined) {
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(
                file,
                JSON.stringify({ shell: resolvedShell, stamp, path } satisfies LoginPathCacheEntry),
                "utf8",
            );
        } catch {
            // best-effort — next start probes again
        }
    }
    return path;
}
