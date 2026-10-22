/**
 * `<environment>` — session-identity facts available at attach time.
 *
 * This block is intentionally stable: cwd, platform, shell, and git identity
 * (current/default branch) do not change during a session. Per-turn mutable
 * git state (recent commits, working-tree changes) continues to live in the
 * dynamic `<recent_git_commits>` / `<working_tree_changes>` tags injected by
 * the builtin git-context extension.
 */

export interface EnvironmentContext {
    /** Absolute working directory. */
    readonly cwd: string;
    /** Node platform id, e.g. "darwin". */
    readonly platform: string;
    /** User's default shell, e.g. "zsh". */
    readonly shell: string;
    /** Whether cwd is inside a git repository. */
    readonly isGitRepository: boolean;
    /** Current branch; undefined when not a git repo. */
    readonly currentBranch?: string;
    /** Default branch (usually "main" or "master"); undefined when not a git repo. */
    readonly defaultBranch?: string;
}

export interface BuildEnvironmentPromptOptions {
    readonly env: EnvironmentContext;
    /** IM/third-party channels: hide absolute paths and project structure. */
    readonly hideWorkspacePath?: boolean;
}

export function buildEnvironmentPrompt(options: BuildEnvironmentPromptOptions): string {
    const { env, hideWorkspacePath } = options;
    const lines = ["<environment>"];

    if (hideWorkspacePath) {
        lines.push(`- Platform: ${platformLabel(env.platform)}, default shell: ${env.shell}`);
    } else {
        lines.push(`- Working directory: ${env.cwd}`);
        lines.push(`- Platform: ${platformLabel(env.platform)}, default shell: ${env.shell}`);
    }

    if (env.isGitRepository) {
        lines.push("- Git repository: yes");
        if (env.currentBranch) lines.push(`- Current branch: ${env.currentBranch}`);
        if (env.defaultBranch) lines.push(`- Default branch: ${env.defaultBranch}`);
    } else {
        lines.push("- Git repository: no");
    }

    lines.push("Relative paths in tool arguments resolve against the working directory above.");
    lines.push("</environment>");
    return lines.join("\n");
}

function platformLabel(platform: string): string {
    switch (platform) {
        case "darwin":
            return "macOS";
        case "win32":
            return "Windows";
        case "linux":
            return "Linux";
        default:
            return platform;
    }
}
