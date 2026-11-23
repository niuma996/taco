/**
 * Validate a shell path glob that may be expanded by the local shell.
 *
 * This is intentionally narrower than Bash's full pattern language: no
 * globstar, braces, extglobs, or unusual literal characters are accepted.
 * A path prefix also prevents an expansion from turning into an option.
 */
export function isSafeReadOnlyPathGlob(arg: string, endOfOptions: boolean): boolean {
    if (arg.includes("**") || !/^(?:[A-Za-z0-9_./-]|\*|\?|\[[!^]?[A-Za-z0-9_-]+\])+$/.test(arg))
        return false;
    const prefix = arg.slice(0, arg.search(/[*?[]/));
    return endOfOptions || (!arg.startsWith("-") && prefix.includes("/"));
}
