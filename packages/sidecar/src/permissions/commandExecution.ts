/** Identify commands whose arguments execute in another shell or environment. */
export function executableName(value: string): string {
    return (
        value
            .split(/[\\/]/)
            .at(-1)
            ?.toLowerCase()
            .replace(/\.exe$/, "") ?? ""
    );
}

export function nestedExecution(argv: readonly string[]): {
    opaque: boolean;
    command?: string;
    complete?: boolean;
} {
    const first = executableName(argv[0] ?? "");
    if (first === "git") {
        let opaque = false;
        const commands: string[] = [];
        for (let i = 1; i < argv.length; i++) {
            const arg = argv[i] ?? "";
            if (!arg.startsWith("-")) break;
            if (["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(arg)) {
                i++;
                continue;
            }
            let config: string | undefined;
            if (arg === "-c") config = argv[++i];
            else if (arg.startsWith("-c")) config = arg.slice(2);
            else if (arg === "--config-env" || arg === "--exec-path") {
                opaque = true;
                i++;
            } else if (arg.startsWith("--config-env=") || arg.startsWith("--exec-path="))
                opaque = true;
            if (config !== undefined && !/^color\.[^=]+=/.test(config)) {
                opaque = true;
                const value = config.slice(config.indexOf("=") + 1);
                if (/^alias\./i.test(config) && value.startsWith("!"))
                    commands.push(value.slice(1));
            }
        }
        return { opaque, command: commands.length ? commands.join("\n") : undefined };
    }
    if (first === "ssh") {
        const withValue = new Set([
            "-B",
            "-b",
            "-c",
            "-D",
            "-E",
            "-e",
            "-F",
            "-I",
            "-i",
            "-J",
            "-L",
            "-l",
            "-m",
            "-O",
            "-o",
            "-P",
            "-p",
            "-Q",
            "-R",
            "-S",
            "-W",
            "-w",
        ]);
        const flags = new Set("1246AaCfGgKkMNnqsTtVvXxYy");
        let i = 1;
        while (argv[i]?.startsWith("-")) {
            const arg = argv[i++] ?? "";
            if (arg === "--") break;
            if (arg === "-" || arg.startsWith("--")) return { opaque: true, complete: false };
            for (let index = 1; index < arg.length; index++) {
                const flag = arg[index] ?? "";
                if (withValue.has(`-${flag}`)) {
                    const value = arg.slice(index + 1) || argv[i] || "";
                    if (
                        flag === "o" &&
                        /^(?:ProxyCommand|LocalCommand|RemoteCommand|KnownHostsCommand|Include)(?:\s|=|$)/i.test(
                            value.trim(),
                        )
                    )
                        return { opaque: true, complete: false };
                    if (index === arg.length - 1) i++;
                    break;
                }
                if (!flags.has(flag)) return { opaque: true, complete: false };
            }
        }
        return { opaque: true, command: argv.slice(i + 1).join(" ") || undefined };
    }
    if (["docker", "podman", "kubectl"].includes(first)) {
        const sub = argv.findIndex(
            (arg) => arg === "exec" || (first !== "kubectl" && arg === "run"),
        );
        if (sub === -1) return { opaque: false };
        const delimiter = argv.indexOf("--", sub + 1);
        if (first === "kubectl")
            return {
                opaque: true,
                command: delimiter === -1 ? undefined : argv.slice(delimiter + 1).join(" "),
            };
        const withValue = new Set([
            "-u",
            "--user",
            "-w",
            "--workdir",
            "-e",
            "--env",
            "--env-file",
            "--detach-keys",
            "--name",
            "--entrypoint",
            "-v",
            "--volume",
            "--mount",
            "--network",
            "-p",
            "--publish",
        ]);
        const flags = new Set([
            "-d",
            "--detach",
            "-i",
            "--interactive",
            "-t",
            "--tty",
            "--rm",
            "--privileged",
            "--init",
            "--read-only",
        ]);
        let entrypoint: string | undefined;
        let i = sub + 1;
        while (argv[i]?.startsWith("-")) {
            const arg = argv[i++];
            if (arg === "--") break;
            if (arg?.startsWith("--entrypoint=")) entrypoint = arg.slice("--entrypoint=".length);
            else if (arg && withValue.has(arg)) {
                if (arg === "--entrypoint") entrypoint = argv[i];
                i++;
            } else if (arg && !flags.has(arg) && !arg.includes("=")) {
                return { opaque: true, complete: false };
            }
        }
        return {
            opaque: true,
            command:
                [...(entrypoint ? [entrypoint] : []), ...argv.slice(i + 1)].join(" ") || undefined,
        };
    }
    return { opaque: false };
}
