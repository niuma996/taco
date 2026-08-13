/**
 * Build the platform-aware system-prompt fragment from the host OS.
 *
 * Selects OS-specific constants from `templates/platform.ts` and appends
 * shell-specific guidance only when the `shell` tool is in the available set.
 * This keeps read-only agents like `explorer` from seeing shell instructions
 * they cannot act on.
 */

import {
    PLATFORM_GENERIC,
    PLATFORM_LINUX,
    PLATFORM_MACOS,
    PLATFORM_WINDOWS,
    SHELL_PLATFORM_GENERIC,
    SHELL_PLATFORM_LINUX,
    SHELL_PLATFORM_MACOS,
    SHELL_PLATFORM_WINDOWS,
} from "./templates/platform.ts";

export function buildPlatformPrompt(
    platform: NodeJS.Platform = process.platform,
    toolNames: ReadonlyArray<string> = [],
): string {
    const hasShell = toolNames.includes("shell");
    const parts: string[] = [];

    switch (platform) {
        case "win32":
            parts.push(PLATFORM_WINDOWS);
            if (hasShell) parts.push(SHELL_PLATFORM_WINDOWS);
            break;
        case "darwin":
            parts.push(PLATFORM_MACOS);
            if (hasShell) parts.push(SHELL_PLATFORM_MACOS);
            break;
        case "linux":
            parts.push(PLATFORM_LINUX);
            if (hasShell) parts.push(SHELL_PLATFORM_LINUX);
            break;
        default:
            parts.push(PLATFORM_GENERIC);
            if (hasShell) parts.push(SHELL_PLATFORM_GENERIC);
    }

    return parts.join("\n\n");
}
