import type { ParsedShellNode } from "./shellParser.ts";

const LS_FLAGS = /^-[1aAbBcCdfFgGhiklLmnpqQrRsStuUx]+$/;
const LS_LONG_FLAGS = new Set([
    "--all",
    "--almost-all",
    "--directory",
    "--human-readable",
    "--inode",
    "--numeric-uid-gid",
    "--recursive",
    "--reverse",
    "--size",
]);

/** Accept path patterns without letting expanded filenames become options. */
export function isReadOnlyLsPathGlob(node: ParsedShellNode): boolean {
    if (node.argv[0] !== "ls" || node.argumentKinds[0] !== "literal" || node.redirects)
        return false;
    if (!node.argumentKinds.includes("glob")) return false;
    let endOfOptions = false;
    return node.argv.slice(1).every((arg, index) => {
        const kind = node.argumentKinds[index + 1];
        if (kind === "glob") {
            // Deliberately exclude globstar, braces, extglobs, and unusual
            // literal characters until their shell semantics are supported.
            if (
                arg.includes("**") ||
                !/^(?:[A-Za-z0-9_./-]|\*|\?|\[[!^]?[A-Za-z0-9_-]+\])+$/.test(arg)
            )
                return false;
            const prefix = arg.slice(0, arg.search(/[*?[]/));
            return endOfOptions || (!arg.startsWith("-") && prefix.includes("/"));
        }
        if (kind !== "literal") return false;
        if (endOfOptions) return true;
        if (arg === "--") {
            endOfOptions = true;
            return true;
        }
        return !arg.startsWith("-") || LS_FLAGS.test(arg) || LS_LONG_FLAGS.has(arg);
    });
}
