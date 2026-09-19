/**
 * Windows-only spawn option: hide the console of a console-subsystem child
 * (git.cmd, rg.exe, powershell.exe, …). Node ignores `windowsHide` on POSIX,
 * so callers can spread this into every spawn/execFile without a platform
 * branch. Session-switch flashes come from git-context probing several
 * `git` processes in parallel without this flag.
 */
export const HIDDEN_WINDOWS_SPAWN = { windowsHide: true } as const;
