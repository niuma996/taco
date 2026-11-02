/**
 * Build the platform-aware system-prompt fragment from the host OS.
 *
 * Selects OS-specific constants from `templates/platform.ts` and appends
 * shell-specific guidance only when the `shell` tool is in the available set.
 * This keeps read-only agents like `explorer` from seeing shell instructions
 * they cannot act on.
 *
 * `readOnlyShell` says the session's shell is the read-only broker. The broker
 * checks the Unix-style read-only command set and never prompts for approval,
 * so those sessions get variants that do not name PowerShell cmdlets or tell
 * them to run builds and tests.
 */

import {
    PLATFORM_GENERIC,
    PLATFORM_LINUX,
    PLATFORM_MACOS,
    PLATFORM_WINDOWS,
    PLATFORM_WINDOWS_READ_ONLY,
    SHELL_PLATFORM_GENERIC,
    SHELL_PLATFORM_GENERIC_READ_ONLY,
    SHELL_PLATFORM_LINUX,
    SHELL_PLATFORM_LINUX_READ_ONLY,
    SHELL_PLATFORM_MACOS,
    SHELL_PLATFORM_MACOS_READ_ONLY,
    SHELL_PLATFORM_WINDOWS,
    SHELL_PLATFORM_WINDOWS_READ_ONLY,
} from "./templates/platform.ts";

export function buildPlatformPrompt(
    platform: NodeJS.Platform = process.platform,
    toolNames: ReadonlyArray<string> = [],
    readOnlyShell = false,
): string {
    const hasShell = toolNames.includes("shell");
    const readOnly = readOnlyShell && hasShell;
    const parts: string[] = [];

    switch (platform) {
        case "win32":
            parts.push(readOnly ? PLATFORM_WINDOWS_READ_ONLY : PLATFORM_WINDOWS);
            if (hasShell) {
                parts.push(readOnly ? SHELL_PLATFORM_WINDOWS_READ_ONLY : SHELL_PLATFORM_WINDOWS);
            }
            break;
        case "darwin":
            parts.push(PLATFORM_MACOS);
            if (hasShell) {
                parts.push(readOnly ? SHELL_PLATFORM_MACOS_READ_ONLY : SHELL_PLATFORM_MACOS);
            }
            break;
        case "linux":
            parts.push(PLATFORM_LINUX);
            if (hasShell) {
                parts.push(readOnly ? SHELL_PLATFORM_LINUX_READ_ONLY : SHELL_PLATFORM_LINUX);
            }
            break;
        default:
            parts.push(PLATFORM_GENERIC);
            if (hasShell) {
                parts.push(readOnly ? SHELL_PLATFORM_GENERIC_READ_ONLY : SHELL_PLATFORM_GENERIC);
            }
    }

    return parts.join("\n\n");
}
