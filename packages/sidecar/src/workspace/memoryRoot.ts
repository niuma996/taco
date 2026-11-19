/** Resolve inherited memory ownership without spawning Git or granting access to source files. */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function directory(path: string): string {
    const real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new Error("Git directory is unavailable");
    return real;
}

function line(path: string): string {
    const body = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    if (!body || /[\r\n\0]/.test(body)) throw new Error("Invalid Git path metadata");
    return body;
}

function gitDirectory(checkout: string): string {
    const marker = join(checkout, ".git");
    const stat = lstatSync(marker);
    if (stat.isDirectory()) return directory(marker);
    if (!stat.isFile()) throw new Error("Invalid Git checkout marker");
    const pointer = line(marker);
    if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid Git directory pointer");
    return directory(resolve(checkout, pointer.slice(8)));
}

/** Accept only local ownership settings whose meaning does not depend on config includes. */
function configuredCheckout(common: string): { worktree?: string; bare: boolean } {
    let core = false;
    let extensions = false;
    let checkout: string | undefined;
    let bare = false;
    for (const raw of readFileSync(join(common, "config"), "utf8").split(/\r?\n/)) {
        const text = raw.trim();
        if (!text || /^[#;]/.test(text)) continue;
        if (text.endsWith("\\")) throw new Error("Git config requires line continuation");
        if (text.startsWith("[")) {
            // Includes can override ownership; callers may inject a preverified resolver instead.
            if (/^\[include(?:if)?\b/i.test(text)) throw new Error("Git config requires includes");
            if (/^\[core\b/i.test(text) && !/^\[core\]$/i.test(text))
                throw new Error("Unsupported Git core section");
            if (/^\[extensions\b/i.test(text) && !/^\[extensions\]$/i.test(text))
                throw new Error("Unsupported Git extensions section");
            core = /^\[core\]$/i.test(text);
            extensions = /^\[extensions\]$/i.test(text);
            continue;
        }
        if (extensions && /^worktreeconfig\b/i.test(text))
            throw new Error("Git config requires per-worktree ownership resolution");
        if (!core) continue;
        const bareValue = /^bare\s*(?:=\s*(.*))?$/i.exec(text);
        if (bareValue) {
            bare = !/^(false|no|off|0)$/i.test(bareValue[1] ?? "true");
            continue;
        }
        const match = /^worktree\s*=\s*(.*)$/i.exec(text);
        if (!match && /^worktree\b/i.test(text)) throw new Error("Unsupported Git worktree config");
        if (!match) continue;
        const value = match[1] ?? "";
        if (value.startsWith('"')) {
            if (!/^"(?:[^"\\]|\\[\\"ntb])*"$/.test(value))
                throw new Error("Unsupported Git worktree config");
            checkout = value
                .slice(1, -1)
                .replace(
                    /\\([\\"ntb])/g,
                    (_, char: string) => ({ n: "\n", t: "\t", b: "\b" })[char] ?? char,
                );
        } else {
            if (!value || /["\\#;]/.test(value)) throw new Error("Unsupported Git worktree config");
            checkout = value;
        }
    }
    return { worktree: checkout ? directory(resolve(common, checkout)) : undefined, bare };
}

/**
 * Preserve ordinary workspace identities. A linked checkout inherits only after its Git
 * directory, common directory, backlink and main checkout marker agree. Invalid or missing
 * metadata falls back to the granted root's own partition, never a guessed project.
 */
export function resolveMemoryRoot(root: string): string {
    if (!isAbsolute(root)) return root;
    try {
        for (let checkout = directory(root); ; checkout = dirname(checkout)) {
            let markerExists = true;
            try {
                lstatSync(join(checkout, ".git"));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                markerExists = false;
            }
            if (markerExists) {
                const gitDir = gitDirectory(checkout);
                let common: string;
                try {
                    common = directory(resolve(gitDir, line(join(gitDir, "commondir"))));
                } catch {
                    return root;
                }
                if (dirname(gitDir) !== join(common, "worktrees")) return root;
                if (
                    realpathSync.native(resolve(gitDir, line(join(gitDir, "gitdir")))) !==
                    join(checkout, ".git")
                )
                    return root;
                if (
                    !statSync(join(gitDir, "HEAD")).isFile() ||
                    !statSync(join(common, "objects")).isDirectory()
                )
                    return root;
                const config = configuredCheckout(common);
                if (config.bare) return root;
                const main =
                    config.worktree ??
                    (basename(common) === ".git" ? directory(dirname(common)) : undefined);
                if (!main || gitDirectory(main) !== common) return root;
                return main;
            }
            if (dirname(checkout) === checkout) return root;
        }
    } catch {
        return root;
    }
}
