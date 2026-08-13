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

export const PLATFORM_GENERIC = `**Platform: unknown.** Sense the environment before running commands.
- Do not assume a package manager or a specific shell; check what is available first.
- Prefer portable commands.`;

export const SHELL_PLATFORM_MACOS =
    "**Shell tool (macOS):** runs `bash/sh`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations.";

export const SHELL_PLATFORM_LINUX =
    "**Shell tool (Linux):** runs `bash`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations.";

export const SHELL_PLATFORM_WINDOWS =
    "**Shell tool (Windows):** runs `powershell.exe -NoProfile -Command`. There is no `bash`. Prefer `read`, `grep`, and `glob` for file access; use `shell` for builds, tests, git, and other shell-only operations.";

export const SHELL_PLATFORM_GENERIC =
    "**Shell tool:** runs the host shell. Prefer `read`, `grep`, and `glob` for file access; use `shell` only when no dedicated tool fits.";
