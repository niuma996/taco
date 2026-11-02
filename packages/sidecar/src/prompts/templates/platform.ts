/**
 * Platform-specific system-prompt fragments.
 *
 * Adapted from the reference agent's `platform/*.md`. The platform section
 * describes the host OS and package managers. Shell-specific guidance is kept
 * separately in `SHELL_PLATFORM_*` so it is only injected when the `shell` tool
 * is actually available.
 */

export const PLATFORM_MACOS = `**Platform: macOS.** The interactive default shell is zsh.
- Package manager: Homebrew (\`brew install ...\`).
- Prefer POSIX-portable commands; BSD variants of \`sed\`/\`grep\` differ from GNU — avoid GNU-only flags.`;

export const PLATFORM_LINUX = `**Platform: Linux.**
- Package manager varies by distro: apt / dnf / yum / pacman. Detect before assuming.
- GNU coreutils are the norm; standard \`sed\`/\`grep\`/\`awk\` flags apply.`;

export const PLATFORM_WINDOWS = `**Platform: Windows.**
- Use PowerShell cmdlets (\`Get-ChildItem\`, \`Remove-Item\`, \`Copy-Item\`), not Unix commands.
- Package manager: winget / Chocolatey / Scoop.
- Paths use backslashes; quote paths that contain spaces.`;

/**
 * Windows platform block for a session whose shell is the read-only broker.
 * The broker checks the Unix-style read-only command set, so it does not
 * recognize PowerShell cmdlets — telling the session to use them sends it at
 * commands that are denied.
 */
export const PLATFORM_WINDOWS_READ_ONLY = `**Platform: Windows.**
- This shell is read-only: it recognizes the strict read-only commands listed in your role prompt, not PowerShell cmdlets — use \`glob\`, \`grep\`, and \`read\` for files.
- Package manager: winget / Chocolatey / Scoop.
- Paths use backslashes; quote paths that contain spaces.`;

export const PLATFORM_GENERIC = `**Platform: unknown.** Sense the environment before running commands.
- Do not assume a package manager or a specific shell; check what is available first.
- Prefer portable commands.`;

/** Appended to every shell block so the four platforms cannot drift. */
const SHELL_APPROVAL_NOTE =
    " Dedicated file tools (`read`, `grep`, `glob`) do not go through command approval. A `shell` command does: one the policy knows may run on its own, but one it cannot analyze asks for approval every time — reach for a dedicated tool first.";

/** Replaces the approval note when the shell is the read-only broker. */
const SHELL_READ_ONLY_NOTE =
    " The shell is read-only: only commands the read-only policy recognizes will run — builds, tests, and writes are denied. Prefer `read`, `grep`, and `glob` for file access; use `shell` mainly for git history.";

export const SHELL_PLATFORM_MACOS =
    "**Shell tool (macOS):** runs `bash/sh`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations." +
    SHELL_APPROVAL_NOTE;

export const SHELL_PLATFORM_LINUX =
    "**Shell tool (Linux):** runs `bash`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations." +
    SHELL_APPROVAL_NOTE;

export const SHELL_PLATFORM_WINDOWS =
    "**Shell tool (Windows):** runs `powershell.exe -NoProfile -Command`. There is no `bash`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations." +
    SHELL_APPROVAL_NOTE;

export const SHELL_PLATFORM_GENERIC =
    "**Shell tool:** runs the host shell. Prefer `read`, `grep`, and `glob` for file access; use `shell` only when no dedicated tool fits." +
    SHELL_APPROVAL_NOTE;

export const SHELL_PLATFORM_MACOS_READ_ONLY =
    "**Shell tool (macOS):** runs `bash/sh`." + SHELL_READ_ONLY_NOTE;

export const SHELL_PLATFORM_LINUX_READ_ONLY =
    "**Shell tool (Linux):** runs `bash`." + SHELL_READ_ONLY_NOTE;

export const SHELL_PLATFORM_WINDOWS_READ_ONLY =
    "**Shell tool (Windows):** runs `powershell.exe -NoProfile -Command`. There is no `bash`." +
    SHELL_READ_ONLY_NOTE;

export const SHELL_PLATFORM_GENERIC_READ_ONLY =
    "**Shell tool:** runs the host shell." + SHELL_READ_ONLY_NOTE;
